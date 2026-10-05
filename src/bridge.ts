import net from "node:net";
import { PROTOCOL_VERSION, readBridgeInfo, type BridgeInfo } from "./discovery.js";

export const CLIENT_NAME = "hive-mcp/0.1.0";
const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 40_000;

/** Error returned by hive (or by this client when hive cannot be reached). */
export class HiveError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
    this.name = "HiveError";
  }
}

export const NOT_RUNNING_MESSAGE =
  "hive is not running (or 'Allow AI tools (MCP)' is off in hive Settings). Start hive and open the project, then retry.";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * One TCP connection to the running hive app (newline-delimited JSON with a token handshake).
 * Reconnects lazily: every call re-reads the discovery file when there is no live connection,
 * so restarting hive or switching projects needs no MCP restart.
 */
export class HiveBridge {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  info: BridgeInfo | null = null;

  constructor(private readonly loadInfo: () => Promise<BridgeInfo | null> = () => readBridgeInfo()) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HiveError("timeout", `hive did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} s.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** True when the discovery file exists and a handshake succeeds. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<net.Socket> {
    const info = await this.loadInfo();
    if (!info) throw new HiveError("not_running", NOT_RUNNING_MESSAGE);
    if (info.protocol !== PROTOCOL_VERSION) {
      throw new HiveError(
        "protocol_mismatch",
        `hive ${info.appVersion} speaks bridge protocol ${info.protocol}, this server speaks ${PROTOCOL_VERSION}. Update hive and hive-mcp to matching versions.`,
      );
    }
    this.info = info;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection({ host: "127.0.0.1", port: info.port });
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new HiveError("not_running", NOT_RUNNING_MESSAGE));
      }, CONNECT_TIMEOUT_MS);
      candidate.once("connect", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", () => {
        clearTimeout(timer);
        reject(new HiveError("not_running", NOT_RUNNING_MESSAGE));
      });
    });
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    await this.handshake(socket, info);
    this.buffer = "";
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => socket.destroy());
    this.socket = socket;
    return socket;
  }

  private handshake(socket: net.Socket, info: BridgeInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      let received = "";
      const timer = setTimeout(() => fail(new HiveError("not_running", NOT_RUNNING_MESSAGE)), CONNECT_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: string) => {
        received += chunk;
        const newline = received.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        socket.off("data", onData);
        let message: { type?: string; code?: string; message?: string };
        try {
          message = JSON.parse(received.slice(0, newline));
        } catch {
          fail(new HiveError("internal", "hive sent an unreadable handshake."));
          return;
        }
        if (message.type === "welcome") {
          const rest = received.slice(newline + 1);
          if (rest) this.buffer = rest;
          resolve();
        } else {
          fail(new HiveError(message.code ?? "unauthorized", message.message ?? "hive refused the connection."));
        }
      };
      socket.on("data", onData);
      socket.once("close", () => fail(new HiveError("not_running", NOT_RUNNING_MESSAGE)));
      socket.write(`${JSON.stringify({ type: "hello", token: info.token, client: CLIENT_NAME, protocol: PROTOCOL_VERSION })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; result?: unknown; error?: { code?: string; message?: string; data?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new HiveError(message.error.code ?? "internal", message.error.message ?? "hive reported an error.", message.error.data));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  private onClose(): void {
    this.socket = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HiveError("not_running", "The connection to hive closed before it answered. If hive quit, start it and retry."));
      this.pending.delete(id);
    }
  }
}
