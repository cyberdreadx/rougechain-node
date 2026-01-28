import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { BlockV1 } from "../types";

export class ChainStore {
  private dir: string;
  private chainPath: string;
  private tipPath: string;

  constructor(baseDir: string) {
    this.dir = baseDir;
    this.chainPath = path.join(baseDir, "chain.jsonl");
    this.tipPath = path.join(baseDir, "tip.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.chainPath)) {
      await writeFile(this.chainPath, "", "utf8");
    }
    if (!existsSync(this.tipPath)) {
      await writeFile(this.tipPath, JSON.stringify({ height: -1, hash: "0".repeat(64) }), "utf8");
    }
  }

  async getTip(): Promise<{ height: number; hash: string }> {
    const raw = await readFile(this.tipPath, "utf8");
    try {
      return JSON.parse(raw) as { height: number; hash: string };
    } catch {
      const fallback = { height: -1, hash: "0".repeat(64) };
      await writeFile(this.tipPath, JSON.stringify(fallback), "utf8");
      return fallback;
    }
  }

  async setTip(tip: { height: number; hash: string }): Promise<void> {
    await writeFile(this.tipPath, JSON.stringify(tip), "utf8");
  }

  async appendBlock(block: BlockV1): Promise<void> {
    await appendFile(this.chainPath, JSON.stringify(block) + "\n", "utf8");
    await this.setTip({ height: block.header.height, hash: block.hash });
  }

  async getBlock(height: number): Promise<BlockV1 | null> {
    // Simple scan (ok for devnet). Production would index by height/hash.
    const raw = await readFile(this.chainPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      const b = JSON.parse(line) as BlockV1;
      if (b.header.height === height) return b;
    }
    return null;
  }

  async getAllBlocks(): Promise<BlockV1[]> {
    const raw = await readFile(this.chainPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.map(line => JSON.parse(line) as BlockV1).sort((a, b) => a.header.height - b.header.height);
  }

  async scanBlocks(
    onBlock: (block: BlockV1) => Promise<void> | void,
    fromHeight: number = 0
  ): Promise<void> {
    const stream = createReadStream(this.chainPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const block = JSON.parse(trimmed) as BlockV1;
      if (block.header.height < fromHeight) continue;
      await onBlock(block);
    }
  }
}

