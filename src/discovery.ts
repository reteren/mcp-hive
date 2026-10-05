import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** hive's Tauri identifier; its config dir holds the bridge discovery file and the last project. */
export const HIVE_IDENTIFIER = "dev.hive.app";
export const PROTOCOL_VERSION = 1;

export interface BridgeInfo {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  appVersion: string;
  project: { name: string; root: string } | null;
}

/** Tauri canonical paths may carry the Windows extended-length prefix `\\?\`. */
export function stripExtendedPrefix(value: string): string {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

/** Same location as Tauri's app_config_dir() for this identifier. */
export function hiveConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HIVE_CONFIG_DIR) return env.HIVE_CONFIG_DIR;
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, HIVE_IDENTIFIER);
  }
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", HIVE_IDENTIFIER);
  const base = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, HIVE_IDENTIFIER);
}

export async function readBridgeInfo(configDir = hiveConfigDir()): Promise<BridgeInfo | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDir, "mcp-bridge.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<BridgeInfo>;
    if (typeof value.port !== "number" || typeof value.token !== "string") return null;
    return {
      protocol: typeof value.protocol === "number" ? value.protocol : 0,
      port: value.port,
      token: value.token,
      pid: typeof value.pid === "number" ? value.pid : 0,
      appVersion: typeof value.appVersion === "string" ? value.appVersion : "unknown",
      project: value.project && typeof value.project.root === "string"
        ? { name: String(value.project.name ?? path.basename(value.project.root)), root: stripExtendedPrefix(value.project.root) }
        : null,
    };
  } catch {
    return null;
  }
}

/** The project hive opened last (used for read-only access while hive is closed). */
export async function readLastProjectRoot(configDir = hiveConfigDir()): Promise<string | null> {
  if (process.env.HIVE_PROJECT_DIR) return process.env.HIVE_PROJECT_DIR;
  try {
    const value = JSON.parse(await readFile(path.join(configDir, "last-project.json"), "utf8")) as unknown;
    if (typeof value !== "string" || !value) return null;
    return stripExtendedPrefix(value);
  } catch {
    return null;
  }
}
