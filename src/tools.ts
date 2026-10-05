import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { HiveBridge, HiveError } from "./bridge.js";
import { readLastProjectRoot } from "./discovery.js";
import { contentToBlocks, offlineContent, youtubeBlocksFor, youtubeIdsIn, youtubeToBlocks, type Block } from "./content.js";
import { readYouTube } from "./youtube.js";
import {
  loadOfflineProject,
  offlineGet,
  offlineLinks,
  offlineList,
  offlineSearch,
  offlineStatus,
  offlineZones,
  type OfflineProject,
} from "./offline.js";

type ToolResult = {
  content: Block[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof HiveError
    ? `[${error.code}] ${error.message}${error.data === undefined ? "" : `\n${JSON.stringify(error.data, null, 2)}`}`
    : error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Drop undefined keys so hive receives exactly what the model specified. */
function clean<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

// ---------- shared schemas ----------

const NodeId = z.string().min(1).describe("Node id (from list_nodes / search_nodes / create_nodes).");
const Point = z.object({ x: z.number(), y: z.number() });
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use #rrggbb.");
const Glow = z.object({
  color: HexColor,
  opacity: z.number().min(0.05).max(1),
  size: z.number().positive().describe("Blur radius in board units."),
});
const TaskInput = z.union([z.boolean(), z.object({ done: z.boolean() })]);
const Side = z.enum(["right", "left", "below", "above"]);
const Near = z.object({
  node: z.string().describe("Existing node id, or a `ref` of a node created in the same call."),
  side: Side.optional().describe("Default right."),
  gap: z.number().nonnegative().optional().describe("Distance in board units (default ≈ 6)."),
});
const LinkKind = z.enum(["strong", "weak"]).describe("strong = directed arrow (default); weak = dashed visual line.");
const LinkShape = z.string().describe("Line shape name from describe_node_kinds → enums.linkShapes. Omit for the default.");
const Data = z.record(z.string(), z.unknown()).describe(
  "Kind-specific fields exactly as in describe_node_kinds → kinds[].dataFields (e.g. listItems for list, tiers for tierlist). Validated by hive.",
);

const CreateSpec = z.object({
  ref: z.string().optional().describe("Temporary id for this call, usable in `links[].from/to` and `near.node`."),
  type: z.string().optional().describe("Node kind (default \"note\"). See describe_node_kinds."),
  name: z.string().optional().describe("Title; must be unique in the project — a taken name gets a numeric suffix (the final name is returned)."),
  text: z.string().optional().describe("Markdown body (for text-bearing kinds)."),
  x: z.number().optional().describe("Top-left x in board units. Omit to auto-place without overlaps."),
  y: z.number().optional().describe("Top-left y in board units (y grows downward)."),
  near: Near.optional().describe("Place next to another node instead of giving x/y."),
  width: z.number().positive().optional(),
  height: z.number().positive().nullable().optional().describe("null/omitted = grows with the text."),
  color: HexColor.optional().describe("Main colour (frame/header; a beacon's colour)."),
  accentColor: HexColor.optional().describe("Inner/body colour."),
  glow: Glow.optional(),
  headerHidden: z.boolean().optional(),
  task: TaskInput.optional().describe("true = open task; {done:true} = completed task."),
  importance: z.string().optional().describe("One of enums.importance."),
  purposes: z.array(z.string()).optional().describe("Values from enums.purposes."),
  moods: z.array(z.string()).optional().describe("Values from enums.moods."),
  zoneId: z.string().optional(),
  data: Data.optional(),
});

const TextEdit = z.union([
  z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional().describe("Replace every match; otherwise `find` must match exactly once.") }),
  z.object({ append: z.string() }),
  z.object({ prepend: z.string() }),
]);

const UpdateSpec = z.object({
  id: NodeId,
  name: z.string().optional().describe("Rename (must stay unique; the .md file follows)."),
  text: z.string().optional().describe("Replace the whole Markdown body. Prefer textEdit for small changes."),
  textEdit: TextEdit.optional().describe("Precise edit of the body: find/replace, append or prepend."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().nullable().optional().describe("null = auto height."),
  color: HexColor.nullable().optional().describe("null clears."),
  accentColor: HexColor.nullable().optional().describe("null clears."),
  glow: Glow.nullable().optional().describe("null removes the glow."),
  headerHidden: z.boolean().optional(),
  task: z.union([TaskInput, z.null()]).optional().describe("true/{done} sets the task state; null or false removes the task flag."),
  importance: z.string().nullable().optional().describe("null clears."),
  purposes: z.array(z.string()).optional().describe("Replaces the list."),
  moods: z.array(z.string()).optional().describe("Replaces the list."),
  zoneId: z.string().nullable().optional(),
  data: Data.optional(),
});

const Layout = z.enum(["row", "column", "grid", "tree", "circle"]);

// ---------- registration ----------

export function registerTools(server: McpServer, bridge: HiveBridge): void {
  let offlineCache: { project: OfflineProject; at: number } | null = null;

  async function offline(): Promise<OfflineProject> {
    if (offlineCache && Date.now() - offlineCache.at < 2_000) return offlineCache.project;
    const root = bridge.info?.project?.root ?? (await readLastProjectRoot());
    if (!root) throw new HiveError("not_running", "hive is not running and no previously opened project is known. Start hive.");
    const project = await loadOfflineProject(root);
    offlineCache = { project, at: Date.now() };
    return project;
  }

  /** Live call; for read tools fall back to the project files when hive is not running. */
  async function read(method: string, params: Record<string, unknown>, fallback: (project: OfflineProject) => unknown): Promise<ToolResult> {
    try {
      return ok(await bridge.call(method, params));
    } catch (error) {
      if (error instanceof HiveError && error.code === "not_running") {
        try {
          const value = fallback(await offline());
          return ok(value && typeof value === "object" ? { ...(value as object), offline: true } : value);
        } catch (offlineError) {
          return fail(offlineError);
        }
      }
      return fail(error);
    }
  }

  async function write(method: string, params: Record<string, unknown>): Promise<ToolResult> {
    try {
      return ok(await bridge.call(method, params));
    } catch (error) {
      return fail(error);
    }
  }

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

  server.registerTool("get_status", {
    title: "hive status",
    description:
      "Start here. Returns whether hive is running, the open project (name, folder), object counts, the camera and the visible board area (board units) and the current selection. " +
      "When hive is closed the result has offline:true and only read tools work.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => read("status", {}, (project) => offlineStatus(project)));

  server.registerTool("describe_node_kinds", {
    title: "Node kinds and fields",
    description:
      "Every node kind hive supports (note, beacon, list, tierlist, goal, calendar, …) with a description, default width, whether it has a Markdown body, and its kind-specific `data` fields; " +
      "plus the allowed values for importance, purposes, moods, link kinds and shapes, and the Markdown syntax hive renders. Call before creating anything other than plain notes. Needs hive running.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => write("schema", {}));

  server.registerTool("list_nodes", {
    title: "List nodes",
    description:
      "List nodes with filters (kind, zone, task state, text query, rectangle, linked to a node) and paging. Returns short summaries with a 160-character text preview; use get_nodes for full text. " +
      "Coordinates are board units, x/y = top-left, y grows downward.",
    inputSchema: z.object({
      types: z.array(z.string()).optional().describe("Only these kinds."),
      zoneId: z.string().optional(),
      task: z.enum(["open", "done", "any", "none"]).optional(),
      query: z.string().optional().describe("Substring in name or text."),
      bbox: Rect.optional().describe("Only nodes intersecting this board rectangle."),
      linkedTo: z.string().optional().describe("Only nodes linked to this node id."),
      sort: z.enum(["position", "created", "name"]).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
      offset: z.number().int().min(0).optional(),
    }),
    annotations: readOnly,
  }, async (input) => read("nodes.list", clean(input), (project) => offlineList(project, input)));

  server.registerTool("get_nodes", {
    title: "Get nodes",
    description: "Full data of up to 50 nodes by id or exact name: every stored field, the complete Markdown text, effective size, links (with the other node's name) and zone.",
    inputSchema: z.object({
      ids: z.array(z.string()).max(50).optional(),
      names: z.array(z.string()).max(50).optional().describe("Exact names (case-insensitive fallback)."),
    }),
    annotations: readOnly,
  }, async (input) => read("nodes.get", clean(input), (project) => offlineGet(project, input.ids, input.names)));

  server.registerTool("search_nodes", {
    title: "Search",
    description: "Search node names, kinds and text with hive's own Search ranking (name matches first). Returns ids, names and a snippet around the match.",
    inputSchema: z.object({
      query: z.string().min(1),
      types: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
    }),
    annotations: readOnly,
  }, async (input) => read("search", clean(input), (project) => offlineSearch(project, input.query, input.types, input.limit)));

  server.registerTool("create_nodes", {
    title: "Create nodes",
    description:
      "Create one or many nodes (any kind) and optionally link them, in ONE undoable step (Ctrl+Z in hive removes the whole batch). " +
      "Nodes get the same defaults as hive's Q menu. Placement: explicit x/y, else `near` another node, else automatic placement from `origin` (default: centre of the visible area) using `layout`, never overlapping existing nodes. " +
      "Use `ref` to link nodes created in the same call (e.g. a mind map: layout \"tree\" + links from the root). Returns the final ids, names and positions.",
    inputSchema: z.object({
      nodes: z.array(CreateSpec).min(1).max(200),
      links: z.array(z.object({ from: z.string(), to: z.string(), kind: LinkKind.optional(), shape: LinkShape.optional() }))
        .optional().describe("from/to: node ids or refs from `nodes`."),
      layout: z.enum(["auto", "row", "column", "grid", "tree"]).optional().describe("For nodes without x/y/near. Default auto."),
      origin: Point.optional().describe("Board point where automatic placement starts."),
      gap: z.number().nonnegative().optional(),
    }),
    annotations: additive,
  }, async (input) => write("nodes.create", clean(input)));

  server.registerTool("update_nodes", {
    title: "Update nodes",
    description:
      "Change existing nodes in ONE undoable step: rename, replace or precisely edit the Markdown text (find/replace that must match exactly once, append, prepend), move/resize, colours, glow, header, task state, importance, purposes, moods, zone, kind-specific data. " +
      "Only the fields you pass change.",
    inputSchema: z.object({ updates: z.array(UpdateSpec).min(1).max(200) }),
    annotations: additive,
  }, async (input) => write("nodes.update", clean(input)));

  server.registerTool("delete_nodes", {
    title: "Delete nodes",
    description: "Delete nodes exactly like the Delete key in hive: they go to the Trash (restorable with restore_from_trash) together with their links. mode \"archive\" archives instead. One undoable step.",
    inputSchema: z.object({ ids: z.array(NodeId).min(1).max(500), mode: z.enum(["trash", "archive"]).optional() }),
    annotations: destructive,
  }, async (input) => write("nodes.delete", clean(input)));

  server.registerTool("move_nodes", {
    title: "Move nodes",
    description: "Set exact top-left positions (board units) of nodes. One undoable step.",
    inputSchema: z.object({ moves: z.array(z.object({ id: NodeId, x: z.number(), y: z.number() })).min(1).max(500) }),
    annotations: additive,
  }, async (input) => write("nodes.move", clean(input)));

  server.registerTool("arrange_nodes", {
    title: "Arrange nodes",
    description: "Lay out existing nodes as a row, column, grid, tree (by their links) or circle starting at `origin` (default: their current top-left). One undoable step.",
    inputSchema: z.object({ ids: z.array(NodeId).min(1).max(500), layout: Layout, origin: Point.optional(), gap: z.number().nonnegative().optional() }),
    annotations: additive,
  }, async (input) => write("nodes.arrange", clean(input)));

  server.registerTool("list_links", {
    title: "List links",
    description: "All lines between nodes, or only those touching `nodeId`, with both node names.",
    inputSchema: z.object({ nodeId: z.string().optional() }),
    annotations: readOnly,
  }, async (input) => read("links.list", clean(input), (project) => offlineLinks(project, input.nodeId)));

  server.registerTool("create_links", {
    title: "Create links",
    description: "Draw lines between existing nodes (strong = arrow from → to, weak = dashed). hive's linking rules apply (e.g. beacons only have outgoing links); a refused link explains why. One undoable step.",
    inputSchema: z.object({
      links: z.array(z.object({ from: NodeId, to: NodeId, kind: LinkKind.optional(), shape: LinkShape.optional() })).min(1).max(500),
    }),
    annotations: additive,
  }, async (input) => write("links.create", clean(input)));

  server.registerTool("update_links", {
    title: "Update links",
    description: "Change kind or shape of existing links. One undoable step.",
    inputSchema: z.object({ updates: z.array(z.object({ id: z.string(), kind: LinkKind.optional(), shape: LinkShape.optional() })).min(1).max(500) }),
    annotations: additive,
  }, async (input) => write("links.update", clean(input)));

  server.registerTool("delete_links", {
    title: "Delete links",
    description: "Remove links by id (nodes stay). One undoable step.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1).max(500) }),
    annotations: destructive,
  }, async (input) => write("links.delete", clean(input)));

  server.registerTool("list_zones", {
    title: "List zones",
    description: "Zones (coloured areas that group nodes) with their rectangles and member node ids.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => read("zones.list", {}, (project) => offlineZones(project)));

  server.registerTool("create_zone", {
    title: "Create zone",
    description: "Create a zone either from an explicit rectangle or `around` a set of nodes with padding. One undoable step.",
    inputSchema: z.object({
      name: z.string().optional(),
      color: HexColor.optional(),
      rect: Rect.optional(),
      around: z.object({ ids: z.array(NodeId).min(1), padding: z.number().nonnegative().optional() }).optional(),
    }),
    annotations: additive,
  }, async (input) => write("zones.create", clean(input)));

  server.registerTool("update_zone", {
    title: "Update zone",
    description: "Rename, recolour or move/resize a zone. One undoable step.",
    inputSchema: z.object({ id: z.string(), name: z.string().optional(), color: HexColor.optional(), rect: Rect.optional() }),
    annotations: additive,
  }, async (input) => write("zones.update", clean(input)));

  server.registerTool("delete_zones", {
    title: "Delete zones",
    description: "Delete zones; their nodes stay on the board. One undoable step.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
    annotations: destructive,
  }, async (input) => write("zones.delete", clean(input)));

  server.registerTool("import_file", {
    title: "Import file",
    description:
      "Add a file from disk to the project exactly like dropping it on the board: it is copied into the project folder (big videos above the user's threshold are linked instead) and becomes an image, GIF, PDF, audio, video, text/code (format) or source node. Use an absolute path.",
    inputSchema: z.object({ path: z.string().min(1), x: z.number().optional(), y: z.number().optional(), near: Near.optional(), name: z.string().optional() }),
    annotations: additive,
  }, async (input) => write("files.import", clean(input)));

  server.registerTool("list_trash", {
    title: "List trash",
    description: "Entries in the project's Trash (deleted nodes) that restore_from_trash can bring back.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => read("trash.list", {}, (project) => ({ entries: Array.isArray(project.index.trash) ? project.index.trash : [] })));

  server.registerTool("list_archive", {
    title: "List archive",
    description: "Archived nodes of the project.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => read("archive.list", {}, (project) => ({ entries: Array.isArray(project.index.archive) ? project.index.archive : [] })));

  server.registerTool("restore_from_trash", {
    title: "Restore from trash",
    description: "Restore Trash entries by id (as listed by list_trash) to their old place, with their links. One undoable step.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
    annotations: additive,
  }, async (input) => write("trash.restore", clean(input)));

  server.registerTool("focus_view", {
    title: "Show on screen",
    description: "Move hive's camera so the given nodes (or rectangle) are visible — use after creating something so the user sees it. Not an undo step.",
    inputSchema: z.object({ ids: z.array(NodeId).optional(), bbox: Rect.optional(), zoom: z.number().positive().optional() }),
    annotations: { ...readOnly, idempotentHint: true },
  }, async (input) => write("view.focus", clean(input)));

  server.registerTool("undo_last_change", {
    title: "Undo",
    description: "Undo the most recent change in hive. By default only undoes changes made through this MCP server (entries labelled \"MCP: …\") and refuses if the user changed something since.",
    inputSchema: z.object({ onlyIfMcp: z.boolean().optional().describe("Default true.") }),
    annotations: destructive,
  }, async (input) => write("history.undo", clean(input)));

  server.registerTool("save_project", {
    title: "Save now",
    description: "Write all pending changes to the project folder immediately (hive also saves automatically).",
    inputSchema: z.object({}),
    annotations: { ...additive, idempotentHint: true },
  }, async () => write("project.save", {}));

  // ---------- content: pictures, files, PDFs, media, YouTube ----------

  server.registerTool("read_node_content", {
    title: "Read node content",
    description:
      "Read what is INSIDE nodes, not just their text: images and GIFs come back as real images you can look at (downscaled), " +
      "inline pictures inside notes too; text/code/JSON/CSV files and project-copied sources come back as text; PDFs as page text; " +
      "audio/video as duration, size and a poster frame; YouTube nodes and YouTube links inside notes are expanded with title, channel, description, thumbnail and transcript; " +
      "lists, tierlists, goals, calendars and other modules as their data. Use this to study a project. Up to 10 nodes per call.",
    inputSchema: z.object({
      ids: z.array(NodeId).min(1).max(10),
      maxImagePx: z.number().int().min(256).max(2048).optional().describe("Longest image side, default 1024. Lower it when reading many images."),
      pdfPages: z.object({ from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }).optional().describe("Default pages 1–30."),
      youtube: z.enum(["full", "metadata", "none"]).optional().describe("full (default): title, description, thumbnail and transcript; metadata: without transcript."),
    }),
    annotations: { ...readOnly, openWorldHint: true },
  }, async (input) => {
    const blocks: Block[] = [];
    const youtubeIds: string[] = [];
    for (const id of input.ids) {
      let content: Record<string, unknown>;
      try {
        content = await bridge.call<Record<string, unknown>>("nodes.content", clean({ id, maxImagePx: input.maxImagePx, pdfPages: input.pdfPages }));
      } catch (error) {
        if (error instanceof HiveError && error.code === "not_running") {
          try {
            content = await offlineContent(await offline(), id, 200_000);
          } catch (offlineError) {
            blocks.push({ type: "text", text: `Node ${id}: ${(offlineError as Error).message}` });
            continue;
          }
        } else {
          blocks.push(...fail(error).content.map((block) => ({ ...block, text: `Node ${id}: ${(block as { text: string }).text}` }) as Block));
          continue;
        }
      }
      blocks.push(...contentToBlocks(content, `Node "${String(content.name ?? id)}" (${String(content.type ?? "?")}, id ${id})`));
      for (const videoId of youtubeIdsIn(content)) if (!youtubeIds.includes(videoId)) youtubeIds.push(videoId);
    }
    if (youtubeIds.length && input.youtube !== "none") blocks.push(...(await youtubeBlocksFor(youtubeIds, input.youtube !== "metadata")));
    return { content: blocks };
  });

  server.registerTool("read_youtube", {
    title: "Read a YouTube video",
    description: "Any YouTube link or video id (watch, youtu.be, shorts, embed, live, music): title, channel, length, views, description, thumbnail image and the transcript (captions in the requested language when available, otherwise the original).",
    inputSchema: z.object({
      url: z.string().min(1),
      transcript: z.boolean().optional().describe("Default true."),
      lang: z.string().optional().describe("Preferred caption language code, e.g. \"ru\" or \"en\"."),
    }),
    annotations: { ...readOnly, openWorldHint: true },
  }, async (input) => {
    try {
      return { content: youtubeToBlocks(await readYouTube(input.url, { transcript: input.transcript !== false, lang: input.lang })) };
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool("view_board", {
    title: "Look at the board",
    description:
      "A real screenshot of the hive board as the user sees it — layout, colours, drawings, links, zones, pictures. Without arguments: the current view; with ids or bbox hive briefly moves the camera there, captures and moves it back. Needs the hive window open (not minimized).",
    inputSchema: z.object({ ids: z.array(NodeId).optional(), bbox: Rect.optional(), maxPx: z.number().int().min(512).max(3000).optional().describe("Default 1600.") }),
    annotations: readOnly,
  }, async (input) => {
    try {
      const result = await bridge.call<Record<string, unknown>>("view.capture", clean(input));
      return { content: contentToBlocks(result, "Board screenshot") };
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool("get_board_overview", {
    title: "Project overview",
    description: "A cheap map of the whole project to plan a study: bounds, zones, clusters of connected/nearby nodes with labels, counts per node kind, media counts (images, PDFs, videos, YouTube…), open/done tasks, newest nodes and the longest texts.",
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => read("board.overview", {}, (project) => ({ ...offlineStatus(project), note: "Overview needs hive running; offline status shown instead." })));

  server.registerPrompt("study_project", {
    title: "Study the hive project",
    description: "Read and understand the whole open hive project: structure, every note, pictures, files, PDFs and YouTube videos.",
    argsSchema: z.object({ focus: z.string().optional().describe("Optional topic or question to focus on.") }),
  }, ({ focus }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Study my hive project thoroughly using the hive tools, then give me a structured summary.",
          focus ? `Focus especially on: ${focus}.` : "",
          "Steps:",
          "1. get_status and get_board_overview to learn the size, zones, clusters and media.",
          "2. view_board (whole view, then each zone or big cluster by ids) to see the layout and drawings.",
          "3. list_nodes page by page; read the full content of every node that matters with read_node_content (10 ids per call; use maxImagePx 768 when there are many images).",
          "4. Look at every image, read PDFs and text files, and use the YouTube details/transcripts that read_node_content returns (read_youtube for any remaining links).",
          "5. list_links and list_zones to understand how ideas connect.",
          "Then report: what the project is about, its main areas and how they relate, key facts from images/PDFs/videos, open tasks and priorities, and gaps or contradictions you noticed. Do not change anything in the project.",
        ].filter(Boolean).join("\n"),
      },
    }],
  }));
}
