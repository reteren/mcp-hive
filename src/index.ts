#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { HiveBridge } from "./bridge.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `hive is a spatial board for notes (an Obsidian-like app): nodes (notes, tasks, beacons, lists, tierlists, media…) placed on an infinite board, connected by links and grouped by zones.
- Call get_status first; describe_node_kinds before creating anything but plain notes.
- Coordinates are board units; x/y is a node's top-left; y grows downward. Omit x/y to let hive place nodes without overlaps.
- Every write tool call is ONE undo step in hive (the user can press Ctrl+Z), labelled "MCP: …".
- Find nodes with search_nodes or list_nodes; read full text with get_nodes; edit text precisely with update_nodes textEdit.
- After creating or changing something the user should look at, call focus_view.
- Writes need hive running; while it is closed the read tools show the last project read-only.`;

const server = new McpServer({ name: "hive", version: "0.1.0" }, { instructions: INSTRUCTIONS });
const bridge = new HiveBridge();
registerTools(server, bridge);

await server.connect(new StdioServerTransport());

const shutdown = () => {
  bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
