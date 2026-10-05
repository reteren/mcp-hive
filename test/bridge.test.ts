import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HiveBridge, HiveError } from "../src/bridge.js";
import type { BridgeInfo } from "../src/discovery.js";

type Handler = (method: string, params: unknown) => { result?: unknown; error?: { code: string; message: string } };

const servers: net.Server[] = [];

async function fakeHive(token: string, handler: Handler): Promise<number> {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let authed = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (!authed) {
          if (message.type === "hello" && message.token === token && message.protocol === 1) {
            authed = true;
            socket.write(`${JSON.stringify({ type: "welcome", protocol: 1, appVersion: "test" })}\n`);
          } else {
            socket.end(`${JSON.stringify({ type: "error", code: "unauthorized", message: "Bad token." })}\n`);
          }
          continue;
        }
        socket.write(`${JSON.stringify({ id: message.id, ...handler(message.method, message.params) })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function info(port: number, token: string, protocol = 1): BridgeInfo {
  return { protocol, port, token, pid: 1, appVersion: "test", project: { name: "P", root: "C:/P" } };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("HiveBridge", () => {
  it("performs the handshake and correlates responses by id", async () => {
    const port = await fakeHive("secret", (method, params) => ({ result: { method, params } }));
    const bridge = new HiveBridge(async () => info(port, "secret"));
    const [a, b] = await Promise.all([bridge.call("status"), bridge.call("nodes.get", { ids: ["x"] })]);
    expect(a).toEqual({ method: "status", params: {} });
    expect(b).toEqual({ method: "nodes.get", params: { ids: ["x"] } });
    bridge.close();
  });

  it("maps hive errors to HiveError with code and data", async () => {
    const port = await fakeHive("t", () => ({ error: { code: "not_found", message: "Node 'q' not found." } }));
    const bridge = new HiveBridge(async () => info(port, "t"));
    await expect(bridge.call("nodes.get", { ids: ["q"] })).rejects.toMatchObject({ code: "not_found", message: "Node 'q' not found." });
    bridge.close();
  });

  it("reports a wrong token as unauthorized", async () => {
    const port = await fakeHive("right", () => ({ result: null }));
    const bridge = new HiveBridge(async () => info(port, "wrong"));
    await expect(bridge.call("status")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("reports a missing discovery file or closed port as not_running", async () => {
    await expect(new HiveBridge(async () => null).call("status")).rejects.toMatchObject({ code: "not_running" });
    const closed = await fakeHive("t", () => ({ result: null }));
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(new HiveBridge(async () => info(closed, "t")).call("status")).rejects.toBeInstanceOf(HiveError);
  });

  it("refuses a protocol mismatch before connecting", async () => {
    await expect(new HiveBridge(async () => info(1, "t", 2)).call("status")).rejects.toMatchObject({ code: "protocol_mismatch" });
  });

  it("reconnects after hive restarts on a new port", async () => {
    const first = await fakeHive("a", () => ({ result: 1 }));
    let current = info(first, "a");
    const bridge = new HiveBridge(async () => current);
    expect(await bridge.call("status")).toBe(1);
    bridge.close();
    const second = await fakeHive("b", () => ({ result: 2 }));
    current = info(second, "b");
    expect(await bridge.call("status")).toBe(2);
    bridge.close();
  });
});
