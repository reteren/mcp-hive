import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OfflineProject } from "./offline.js";
import { readYouTube, youtubeVideoId, type YouTubeInfo } from "./youtube.js";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type Json = Record<string, unknown>;

interface ImagePayload {
  file?: string;
  mime: string;
  data: string;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
}

function isImagePayload(value: unknown): value is ImagePayload {
  return !!value && typeof value === "object" && typeof (value as Json).data === "string" && typeof (value as Json).mime === "string";
}

/**
 * Turn hive's NodeContent JSON into MCP blocks: one JSON text block (images replaced by a short
 * placeholder) followed by the images themselves, each preceded by a caption so the model knows
 * which picture is which.
 */
export function contentToBlocks(content: Json, label: string): Block[] {
  const images: { caption: string; payload: ImagePayload }[] = [];
  const strip = (value: unknown, where: string): unknown => {
    if (isImagePayload(value)) {
      const caption = `${label} — ${where}${value.file ? ` (${value.file})` : ""}`;
      images.push({ caption, payload: value });
      return { image: `#${images.length} below`, file: value.file, width: value.width, height: value.height, originalWidth: value.originalWidth, originalHeight: value.originalHeight };
    }
    if (Array.isArray(value)) return value.map((entry, index) => strip(entry, `${where}[${index}]`));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Json).map(([key, entry]) => [key, strip(entry, where ? `${where}.${key}` : key)]));
    }
    return value;
  };
  const json = strip(content, "");
  const blocks: Block[] = [{ type: "text", text: `${label}\n${JSON.stringify(json, null, 2)}` }];
  images.forEach(({ caption, payload }, index) => {
    blocks.push({ type: "text", text: `Image #${index + 1}: ${caption}` });
    blocks.push({ type: "image", data: payload.data, mimeType: payload.mime });
  });
  return blocks;
}

/** Collect YouTube video ids mentioned anywhere in a node's content. */
export function youtubeIdsIn(content: Json): string[] {
  const ids = new Set<string>();
  const youtube = content.youtube as Json | undefined;
  if (youtube && typeof youtube.videoId === "string") ids.add(youtube.videoId);
  for (const link of (content.links as Json[] | undefined) ?? []) {
    const id = typeof link.videoId === "string" ? link.videoId : typeof link.url === "string" ? youtubeVideoId(link.url) : null;
    if (id) ids.add(id);
  }
  if (typeof content.text === "string") {
    for (const match of content.text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
      const id = youtubeVideoId(match[0]);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function youtubeToBlocks(info: YouTubeInfo, withThumbnail = true): Block[] {
  const { thumbnail, ...rest } = info;
  const blocks: Block[] = [{ type: "text", text: `YouTube ${info.videoId}\n${JSON.stringify(rest, null, 2)}` }];
  if (withThumbnail && thumbnail) {
    blocks.push({ type: "text", text: `Thumbnail of YouTube ${info.videoId}${info.title ? ` "${info.title}"` : ""}` });
    blocks.push({ type: "image", data: thumbnail.data, mimeType: thumbnail.mimeType });
  }
  return blocks;
}

export async function youtubeBlocksFor(ids: string[], transcript: boolean): Promise<Block[]> {
  const results = await Promise.all(ids.slice(0, 5).map(async (id) => {
    try {
      return youtubeToBlocks(await readYouTube(id, { transcript }));
    } catch (error) {
      return [{ type: "text", text: `YouTube ${id}: ${(error as Error).message}` } as Block];
    }
  }));
  const blocks = results.flat();
  if (ids.length > 5) blocks.push({ type: "text", text: `${ids.length - 5} more YouTube links not expanded; use read_youtube for them.` });
  return blocks;
}

// ---------- read-only fallback while hive is closed ----------

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TEXT_EXT = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".cs", ".java", ".c", ".cpp", ".h", ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini", ".sql", ".sh", ".ps1", ".lua", ".go", ".kt", ".swift", ".rb", ".php", ".log"]);
const MAX_OFFLINE_IMAGE_BYTES = 3 * 1024 * 1024;

async function offlineFile(project: OfflineProject, file: string, maxTextChars: number): Promise<Json> {
  if (file.includes("/") || file.includes("\\")) return { note: "unsafe file name" };
  const full = path.join(project.root, "attachments", file);
  const ext = path.extname(file).toLowerCase();
  try {
    const info = await stat(full);
    if (IMAGE_MIME[ext]) {
      if (info.size > MAX_OFFLINE_IMAGE_BYTES) return { file, note: "Image too large to send while hive is closed; start hive for a downscaled copy." };
      return { image: { file, mime: IMAGE_MIME[ext], data: (await readFile(full)).toString("base64") } };
    }
    if (TEXT_EXT.has(ext)) {
      const text = await readFile(full, "utf8");
      return { file: { name: file, size: info.size }, content: text.slice(0, maxTextChars), truncated: text.length > maxTextChars };
    }
    return { file: { name: file, size: info.size }, note: "Binary file; start hive to read PDFs and media details." };
  } catch {
    return { file, missing: true };
  }
}

export async function offlineContent(project: OfflineProject, id: string, maxTextChars: number): Promise<Json> {
  const note = project.notes.find((candidate) => candidate.id === id);
  if (!note) throw new Error(`Node '${id}' not found.`);
  const text = project.texts.get(id) ?? "";
  const result: Json = { id, type: note.type ?? "note", name: note.name, text, offline: true };
  const image = note.image as Json | undefined;
  const media = note.media as Json | undefined;
  const source = note.source as Json | undefined;
  if (image && typeof image.file === "string") Object.assign(result, await offlineFile(project, image.file, maxTextChars));
  if (media && typeof media.file === "string") Object.assign(result, { media }, await offlineFile(project, media.file, maxTextChars));
  if (source) Object.assign(result, { source }, typeof source.file === "string" ? await offlineFile(project, source.file, maxTextChars) : {});
  if (note.youtube) result.youtube = note.youtube;
  const inline: Json[] = [];
  for (const match of text.matchAll(/!\[[^\]\n]*\]\(att:([^)]+)\)/g)) {
    if (inline.length >= 10) break;
    const file = decodeURIComponent(match[1]);
    const entry = await offlineFile(project, file, maxTextChars);
    if (entry.image) inline.push(entry.image as Json);
  }
  if (inline.length) result.inlineImages = inline;
  const skip = new Set(["id", "type", "name", "file", "text", "x", "y", "width", "height", "image", "media", "source", "youtube"]);
  const data = Object.fromEntries(Object.entries(note).filter(([key]) => !skip.has(key)));
  if (Object.keys(data).length) result.data = data;
  return result;
}
