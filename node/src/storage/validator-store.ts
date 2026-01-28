import path from "node:path";
import { Level } from "level";

export interface ValidatorState {
  stake: bigint;
  slashCount: number;
  jailedUntil: number;
  entropyContributions: number;
}

interface StoredValidatorState {
  stake: string;
  slashCount: number;
  jailedUntil: number;
  entropyContributions: number;
}

export class ValidatorStateStore {
  private db: Level<string, string>;
  private initialized = false;

  constructor(baseDir: string) {
    const dir = path.join(baseDir, "validator-state");
    this.db = new Level<string, string>(dir, { valueEncoding: "utf8" });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.open();
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.db.close();
    this.initialized = false;
  }

  async reset(): Promise<void> {
    await this.db.clear();
  }

  async getMetaHeight(): Promise<number> {
    try {
      const raw = await this.db.get("meta:lastHeight");
      return Number(raw || -1);
    } catch {
      return -1;
    }
  }

  async setMetaHeight(height: number): Promise<void> {
    await this.db.put("meta:lastHeight", String(height));
  }

  async getValidator(publicKey: string): Promise<ValidatorState | null> {
    try {
      const raw = await this.db.get(this.validatorKey(publicKey));
      const parsed = JSON.parse(raw) as StoredValidatorState;
      return {
        stake: BigInt(parsed.stake),
        slashCount: parsed.slashCount,
        jailedUntil: parsed.jailedUntil,
        entropyContributions: parsed.entropyContributions ?? 0,
      };
    } catch {
      return null;
    }
  }

  async setValidator(publicKey: string, state: ValidatorState): Promise<void> {
    const serialized: StoredValidatorState = {
      stake: state.stake.toString(),
      slashCount: state.slashCount,
      jailedUntil: state.jailedUntil,
      entropyContributions: state.entropyContributions,
    };
    await this.db.put(this.validatorKey(publicKey), JSON.stringify(serialized));
  }

  async deleteValidator(publicKey: string): Promise<void> {
    try {
      await this.db.del(this.validatorKey(publicKey));
    } catch {
      // ignore
    }
  }

  async listValidators(): Promise<Array<{ publicKey: string; state: ValidatorState }>> {
    const results: Array<{ publicKey: string; state: ValidatorState }> = [];
    for await (const [key, value] of this.db.iterator()) {
      if (!key.startsWith("validator:")) continue;
      const publicKey = key.replace("validator:", "");
      const parsed = JSON.parse(value) as StoredValidatorState;
      results.push({
        publicKey,
        state: {
          stake: BigInt(parsed.stake),
          slashCount: parsed.slashCount,
          jailedUntil: parsed.jailedUntil,
          entropyContributions: parsed.entropyContributions ?? 0,
        },
      });
    }
    return results;
  }

  private validatorKey(publicKey: string): string {
    return `validator:${publicKey}`;
  }
}
