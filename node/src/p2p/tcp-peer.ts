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

  private onData(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = decodeNetMessage(line) as P2PMessage;
        this.emit("message", obj);
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
}

