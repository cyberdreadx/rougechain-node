import net from "node:net";
import { EventEmitter } from "node:events";
import type { P2PMessage } from "../types";
import { decodeNetMessage, encodeNetMessage } from "../codec";

export interface PeerEndpoint {
  host: string;
  port: number;
}

export class TcpPeer extends EventEmitter<{
  message: [P2PMessage];
  close: [];
  error: [Error];
}> {
  private socket: net.Socket;
  private buffer = "";
  private maxBufferChars = 1024 * 1024; // 1MB buffer cap for lightweight nodes
  private maxMessageChars = 256 * 1024; // 256KB max message size

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.socket.setNoDelay(true);
    this.socket.setEncoding("utf8");

    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => this.emit("close"));
    this.socket.on("error", (e) => this.emit("error", e));
  }

  static connect(ep: PeerEndpoint): Promise<TcpPeer> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: ep.host, port: ep.port }, () => {
        resolve(new TcpPeer(sock));
      });
      sock.on("error", reject);
    });
  }

  send(msg: P2PMessage): void {
    this.socket.write(encodeNetMessage(msg) + "\n");
  }

  close(): void {
    this.socket.end();
  }

  getRemoteEndpoint(): PeerEndpoint | null {
    const host = this.socket.remoteAddress;
    const port = this.socket.remotePort;
    if (!host || !port) return null;
    return { host, port };
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBufferChars) {
      this.emit("error", new Error("Peer buffer overflow"));
      this.close();
      this.buffer = "";
      return;
    }
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (line.length > this.maxMessageChars) {
        this.emit("error", new Error("Peer message too large"));
        this.close();
        return;
      }
      try {
        const obj = decodeNetMessage(line) as P2PMessage;
        this.emit("message", obj);
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}

