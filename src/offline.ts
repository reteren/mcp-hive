import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Read-only view of a hive project folder, used while hive is closed.
 * Mirrors the shapes of the live bridge's read methods as closely as the files allow
 * (no measured heights, no camera, no selection).
 */

type Json = Record<string, unknown>;

export interface OfflineProject {
  root: string;
  name: string;
  index: Json;
  notes: Json[];
  texts: Map<string, string>;
}

export async function loadOfflineProject(root: string): Promise<OfflineProject> {
  const indexPath = path.join(root, "board.json");
  let index: Json;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as Json;
  } catch (error) {
    throw new Error(`Cannot read ${indexPath}: ${(error as Error).message}`);
  }
  if (!Array.isArray(index.notes)) index = await assembleSplitBoard(root, index);
  const notes = Array.isArray(index.notes) ? (index.notes as Json[]) : [];
  const texts = new Map<string, string>();
  await Promise.all(notes.map(async (note) => {
    const file = typeof note.file === "string" ? note.file : null;
    if (!file || file.includes("/") || file.includes("\\")) return;
    try {
      texts.set(String(note.id), await readFile(path.join(root, "notes", file), "utf8"));
    } catch {
      texts.set(String(note.id), "");
    }
  }));
  return { root, name: path.basename(root), index, notes, texts };
}

/** hive 1.8.3+ keeps one file per object (nodes/<id>.json, …) next to a small board.json. */
const SPLIT_COLLECTIONS: [string, string][] = [
  ["notes", "nodes"], ["links", "links"], ["zones", "zones"], ["trash", "trash"], ["archive", "archive"], ["taskLog", "tasklog"],
];

async function assembleSplitBoard(root: string, head: Json): Promise<Json> {
  const index: Json = { ...head };
  for (const [key, directory] of SPLIT_COLLECTIONS) {
    const items = await readObjects(path.join(root, directory));
    items.sort((a, b) => order(a) - order(b) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
    index[key] = items.map(({ _order: _, ...item }) => item);
  }
  const calculators: Json = {};
  for (const item of await readObjects(path.join(root, "calculators"))) {
    if (typeof item.key === "string") calculators[item.key] = item.value;
  }
  index.calculators = calculators;
  return index;
}

async function readObjects(directory: string): Promise<Json[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const items = await Promise.all(names.map(async (name) => {
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
    } catch {
      return null; // unreadable (e.g. an unresolved Git conflict): skipped
    }
  }));
  return items.filter((item): item is Json => item !== null);
}

function order(item: Json): number {
  return typeof item._order === "number" ? item._order : Number.MAX_VALUE;
}

const PREVIEW = 160;

function textOf(project: OfflineProject, note: Json): string {
  return project.texts.get(String(note.id)) ?? (typeof note.text === "string" ? note.text : "");
}

function typeOf(note: Json): string {
  return typeof note.type === "string" ? note.type : "note";
}

function linksOf(project: OfflineProject): Json[] {
  return Array.isArray(project.index.links) ? (project.index.links as Json[]) : [];
}

function zonesOf(project: OfflineProject): Json[] {
  return Array.isArray(project.index.zones) ? (project.index.zones as Json[]) : [];
}

export function summary(project: OfflineProject, note: Json): Json {
  const id = String(note.id);
  const text = textOf(project, note);
  const task = note.task && typeof note.task === "object" ? { done: Boolean((note.task as Json).done) } : undefined;
  return {
    id,
    type: typeOf(note),
    name: note.name,
    x: note.x,
    y: note.y,
    width: note.width,
    height: note.height ?? null,
    ...(note.color ? { color: note.color } : {}),
    ...(task ? { task } : {}),
    ...(note.importance ? { importance: note.importance } : {}),
    ...(Array.isArray(note.purposes) && note.purposes.length ? { purposes: note.purposes } : {}),
    ...(Array.isArray(note.moods) && note.moods.length ? { moods: note.moods } : {}),
    ...(note.zoneId ? { zoneId: note.zoneId } : {}),
    textPreview: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW),
    linkCount: linksOf(project).filter((link) => link.from === id || link.to === id).length,
  };
}

function linkInfo(project: OfflineProject, link: Json): Json {
  const nameOf = (id: unknown) => project.notes.find((note) => note.id === id)?.name ?? null;
  return { id: link.id, from: link.from, to: link.to, kind: link.kind, shape: link.shape, fromName: nameOf(link.from), toName: nameOf(link.to) };
}

export function offlineStatus(project: OfflineProject): Json {
  const count = (key: string) => (Array.isArray(project.index[key]) ? (project.index[key] as unknown[]).length : 0);
  return {
    live: false,
    readOnly: true,
    project: { name: project.name, root: project.root },
    counts: { nodes: project.notes.length, links: count("links"), zones: count("zones"), trash: count("trash"), archive: count("archive") },
    note: "hive is not running: this is a read-only view of the last opened project. Start hive to make changes.",
  };
}

export interface ListFilter {
  types?: string[];
  zoneId?: string;
  task?: "open" | "done" | "any" | "none";
  query?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  linkedTo?: string;
  sort?: "position" | "created" | "name";
  limit?: number;
  offset?: number;
}

export function offlineList(project: OfflineProject, filter: ListFilter): Json {
  const query = filter.query?.toLowerCase();
  const linked = filter.linkedTo
    ? new Set(linksOf(project).flatMap((link) => (link.from === filter.linkedTo ? [link.to] : link.to === filter.linkedTo ? [link.from] : [])))
    : null;
  let result = project.notes.filter((note) => {
    if (filter.types?.length && !filter.types.includes(typeOf(note))) return false;
    if (filter.zoneId && note.zoneId !== filter.zoneId) return false;
    const task = note.task as Json | null | undefined;
    if (filter.task === "none" && task) return false;
    if (filter.task === "any" && !task) return false;
    if (filter.task === "open" && !(task && !task.done)) return false;
    if (filter.task === "done" && !(task && task.done)) return false;
    if (linked && !linked.has(note.id)) return false;
    if (filter.bbox) {
      const b = filter.bbox;
      const x = Number(note.x), y = Number(note.y), w = Number(note.width), h = Number(note.height ?? 0);
      if (x + w < b.x || x > b.x + b.width || y + h < b.y || y > b.y + b.height) return false;
    }
    if (query && !`${note.name}\n${textOf(project, note)}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const sort = filter.sort ?? "position";
  result = [...result].sort((a, b) =>
    sort === "name" ? String(a.name).localeCompare(String(b.name))
      : sort === "created" ? Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)
        : Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x));
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  return { total: result.length, nodes: result.slice(offset, offset + limit).map((note) => summary(project, note)) };
}

export function offlineGet(project: OfflineProject, ids: string[] = [], names: string[] = []): Json {
  const found: Json[] = [];
  const missing: string[] = [];
  const full = (note: Json): Json => {
    const id = String(note.id);
    const zone = zonesOf(project).find((candidate) => candidate.id === note.zoneId);
    return {
      ...note,
      type: typeOf(note),
      text: textOf(project, note),
      links: linksOf(project).filter((link) => link.from === id || link.to === id).map((link) => linkInfo(project, link)),
      ...(zone ? { zone: { id: zone.id, name: zone.name } } : {}),
    };
  };
  for (const id of ids) {
    const note = project.notes.find((candidate) => candidate.id === id);
    if (note) found.push(full(note));
    else missing.push(id);
  }
  for (const name of names) {
    const note = project.notes.find((candidate) => candidate.name === name)
      ?? project.notes.find((candidate) => String(candidate.name).toLowerCase() === name.toLowerCase());
    if (note) found.push(full(note));
    else missing.push(name);
  }
  return { nodes: found, missing };
}

export function offlineSearch(project: OfflineProject, query: string, types: string[] | undefined, limit = 20): Json {
  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [] };
  const results: Json[] = [];
  for (const note of project.notes) {
    if (types?.length && !types.includes(typeOf(note))) continue;
    const name = String(note.name);
    const text = textOf(project, note);
    let matchedIn: string | null = null;
    let snippet = "";
    if (name.toLowerCase().includes(needle)) {
      matchedIn = "name";
      snippet = name;
    } else if (typeOf(note).toLowerCase().includes(needle)) {
      matchedIn = "kind";
      snippet = typeOf(note);
    } else {
      const at = text.toLowerCase().indexOf(needle);
      if (at !== -1) {
        matchedIn = "text";
        snippet = text.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, " ").trim();
      }
    }
    if (matchedIn) results.push({ id: note.id, name, type: typeOf(note), matchedIn, snippet });
  }
  const rank = { name: 0, kind: 1, text: 2 } as Record<string, number>;
  results.sort((a, b) => rank[String(a.matchedIn)] - rank[String(b.matchedIn)]);
  return { results: results.slice(0, Math.min(100, Math.max(1, limit))) };
}

export function offlineLinks(project: OfflineProject, nodeId?: string): Json {
  const links = linksOf(project).filter((link) => !nodeId || link.from === nodeId || link.to === nodeId);
  return { links: links.map((link) => linkInfo(project, link)) };
}

export function offlineZones(project: OfflineProject): Json {
  return {
    zones: zonesOf(project).map((zone) => ({
      ...zone,
      nodeIds: project.notes.filter((note) => note.zoneId === zone.id).map((note) => note.id),
    })),
  };
}
