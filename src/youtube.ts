/**
 * YouTube enrichment done on the MCP side (hive's webview CSP blocks most of this).
 * Everything is best effort: offline, region-locked or changed pages degrade to what is known.
 */

const TIMEOUT_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 60_000;
const ID = /^[A-Za-z0-9_-]{11}$/;

/** Accepts youtu.be, watch?v=, /shorts/, /embed/, /live/, /v/, m./music./www. hosts and bare ids. */
export function youtubeVideoId(input: string): string | null {
  const value = input.trim();
  if (ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/")[1] ?? "";
    return ID.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const fromQuery = url.searchParams.get("v");
  if (fromQuery && ID.test(fromQuery)) return fromQuery;
  const [, first, second] = url.pathname.split("/");
  if (["shorts", "embed", "live", "v", "e"].includes(first ?? "") && second && ID.test(second)) return second;
  return null;
}

export interface YouTubeInfo {
  videoId: string;
  url: string;
  title?: string;
  author?: string;
  authorUrl?: string;
  description?: string;
  lengthSeconds?: number;
  viewCount?: number;
  thumbnail?: { mimeType: string; data: string };
  transcript?: { language: string; auto: boolean; text: string; truncated: boolean };
  availableTranscriptLanguages?: string[];
  notes: string[];
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string };

/** Innertube clients that still return caption tracks usable without a browser token. */
const PLAYER_CLIENTS = [
  { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 }, userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip" },
  { client: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2" }, userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)" },
];

async function fetchPlayer(videoId: string): Promise<Record<string, unknown>> {
  let lastError = "no client answered";
  for (const { client, userAgent } of PLAYER_CLIENTS) {
    try {
      const response = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify({ context: { client: { ...client, hl: "en" } }, videoId }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const player = (await response.json()) as Record<string, unknown>;
      const status = (player.playabilityStatus as { status?: string } | undefined)?.status;
      if (status === "OK") return player;
      lastError = `video is ${status ?? "unavailable"}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  throw new Error(lastError);
}

function pickTrack(tracks: CaptionTrack[], preferred?: string): CaptionTrack | undefined {
  const manual = tracks.filter((track) => track.kind !== "asr");
  const by = (list: CaptionTrack[], lang?: string) => (lang ? list.find((track) => track.languageCode.startsWith(lang)) : undefined);
  return by(manual, preferred) ?? by(tracks, preferred) ?? manual[0] ?? tracks[0];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Caption bodies come as json3 or as timedtext XML (format 3 `<p>` or legacy `<text>`). */
export function parseCaptions(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as { events?: { segs?: { utf8?: string }[] }[] };
    return (json.events ?? [])
      .map((event) => (event.segs ?? []).map((seg) => seg.utf8 ?? "").join(""))
      .filter((line) => line.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const lines: string[] = [];
  for (const match of trimmed.matchAll(/<(p|text)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const line = decodeEntities(match[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  }
  return lines.join(" ");
}

async function fetchTranscript(track: CaptionTrack): Promise<string> {
  // YouTube rate-limits caption downloads (429) in bursts; one short back-off usually clears it.
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(track.baseUrl);
    if (response.ok) return parseCaptions(await response.text());
    if (response.status === 429 && attempt >= 2) throw new Error("YouTube is rate-limiting transcript downloads from this network right now; try read_youtube again in a while");
    if (response.status !== 429) throw new Error(`captions HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
}

export async function readYouTube(input: string, options: { transcript?: boolean; lang?: string; thumbnail?: boolean } = {}): Promise<YouTubeInfo> {
  const videoId = youtubeVideoId(input);
  if (!videoId) throw new Error(`Not a YouTube video URL or id: ${input}`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const info: YouTubeInfo = { videoId, url, notes: [] };

  const tasks: Promise<void>[] = [];
  tasks.push((async () => {
    try {
      const response = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { title?: string; author_name?: string; author_url?: string };
      info.title ??= body.title;
      info.author ??= body.author_name;
      info.authorUrl ??= body.author_url;
    } catch (error) {
      info.notes.push(`oEmbed unavailable: ${(error as Error).message}`);
    }
  })());

  if (options.thumbnail !== false) {
    tasks.push((async () => {
      for (const name of ["maxresdefault", "hqdefault"]) {
        try {
          const response = await fetchWithTimeout(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`);
          if (!response.ok) continue;
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length < 2_000) continue; // YouTube's grey "no thumbnail" placeholder
          info.thumbnail = { mimeType: "image/jpeg", data: bytes.toString("base64") };
          return;
        } catch {
          // try the next size
        }
      }
      info.notes.push("Thumbnail unavailable.");
    })());
  }

  tasks.push((async () => {
    try {
      const player = await fetchPlayer(videoId);
      const details = (player.videoDetails ?? {}) as Record<string, unknown>;
      if (typeof details.title === "string") info.title ??= details.title;
      if (typeof details.author === "string") info.author ??= details.author;
      if (typeof details.shortDescription === "string") info.description = details.shortDescription;
      if (details.lengthSeconds) info.lengthSeconds = Number(details.lengthSeconds);
      if (details.viewCount) info.viewCount = Number(details.viewCount);
      if (options.transcript === false) return;
      const tracks = (((player.captions ?? {}) as Record<string, Record<string, unknown>>).playerCaptionsTracklistRenderer?.captionTracks ?? []) as CaptionTrack[];
      if (!tracks.length) {
        info.notes.push("This video has no captions, so no transcript is available.");
        return;
      }
      const track = pickTrack(tracks, options.lang);
      if (!track) return;
      const text = await fetchTranscript(track);
      if (!text) {
        info.notes.push("Captions exist but YouTube returned an empty transcript.");
        return;
      }
      info.transcript = {
        language: track.languageCode,
        auto: track.kind === "asr",
        text: text.slice(0, MAX_TRANSCRIPT_CHARS),
        truncated: text.length > MAX_TRANSCRIPT_CHARS,
      };
      info.availableTranscriptLanguages = tracks.map((candidate) => candidate.languageCode + (candidate.kind === "asr" ? " (auto)" : ""));
    } catch (error) {
      info.notes.push(`Video details/transcript unavailable: ${(error as Error).message}`);
    }
  })());

  await Promise.all(tasks);
  return info;
}
