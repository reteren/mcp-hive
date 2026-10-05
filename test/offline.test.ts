import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOfflineProject, offlineGet, offlineLinks, offlineList, offlineSearch, offlineStatus, offlineZones, type OfflineProject } from "../src/offline.js";

let project: OfflineProject;

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hive-mcp-"));
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "Plan.md"), "# Plan\nShip the beta on Friday.");
  await writeFile(path.join(root, "notes", "Ideas.md"), "Obsidian replacement ideas");
  await writeFile(path.join(root, "notes", "Hub.md"), "");
  await writeFile(path.join(root, "board.json"), JSON.stringify({
    version: 3,
    notes: [
      { id: "a", name: "Plan", file: "Plan.md", x: 0, y: 0, width: 30, height: null, task: { done: false, doneAt: null }, zoneId: "z1" },
      { id: "b", name: "Ideas", file: "Ideas.md", x: 50, y: 0, width: 30, height: 20, importance: "important" },
      { id: "c", type: "beacon", name: "Hub", file: "Hub.md", x: 20, y: -40, width: 7.2, height: 7.2, color: "#40a0e0" },
    ],
    links: [{ id: "l1", from: "c", to: "a", kind: "strong", shape: "base" }],
    zones: [{ id: "z1", name: "Work", x: -5, y: -5, width: 40, height: 30, color: "#333333" }],
    trash: [],
  }));
  project = await loadOfflineProject(root);
});

describe("offline project reader", () => {
  it("reports read-only status with counts", () => {
    const status = offlineStatus(project);
    expect(status).toMatchObject({ live: false, readOnly: true, counts: { nodes: 3, links: 1, zones: 1, trash: 0 } });
  });

  it("lists with filters, previews and link counts", () => {
    const tasks = offlineList(project, { task: "open" }) as { total: number; nodes: { id: string; textPreview: string; linkCount: number }[] };
    expect(tasks.total).toBe(1);
    expect(tasks.nodes[0]).toMatchObject({ id: "a", textPreview: "# Plan Ship the beta on Friday.", linkCount: 1 });
    const beacons = offlineList(project, { types: ["beacon"] }) as { nodes: { id: string }[] };
    expect(beacons.nodes.map((node) => node.id)).toEqual(["c"]);
    const linked = offlineList(project, { linkedTo: "c" }) as { nodes: { id: string }[] };
    expect(linked.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("gets full nodes by id and by case-insensitive name", () => {
    const result = offlineGet(project, ["a", "missing"], ["ideas"]) as { nodes: { id: string; text: string; links: unknown[]; zone?: unknown }[]; missing: string[] };
    expect(result.missing).toEqual(["missing"]);
    expect(result.nodes[0]).toMatchObject({ id: "a", text: "# Plan\nShip the beta on Friday.", zone: { id: "z1", name: "Work" } });
    expect(result.nodes[0].links).toHaveLength(1);
    expect(result.nodes[1].id).toBe("b");
  });

  it("searches names before text", () => {
    const result = offlineSearch(project, "plan", undefined) as { results: { id: string; matchedIn: string }[] };
    expect(result.results[0]).toMatchObject({ id: "a", matchedIn: "name" });
    const text = offlineSearch(project, "obsidian", undefined) as { results: { id: string; matchedIn: string; snippet: string }[] };
    expect(text.results[0]).toMatchObject({ id: "b", matchedIn: "text" });
  });

  it("lists links with names and zones with members", () => {
    expect(offlineLinks(project, "a")).toEqual({ links: [{ id: "l1", from: "c", to: "a", kind: "strong", shape: "base", fromName: "Hub", toName: "Plan" }] });
    expect(offlineZones(project)).toMatchObject({ zones: [{ id: "z1", nodeIds: ["a"] }] });
  });
});
