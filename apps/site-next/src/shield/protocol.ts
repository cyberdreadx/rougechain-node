/** Messages between the /shield page and its worker (`worker.ts`). */
import type { PaymentResult, ShieldViewModel } from "./client";
import type { SessionData } from "./loop";

export type WorkerRequest = { id: number } & (
  | { cmd: "init"; network: string; seed: Uint8Array; origins: string[]; session: SessionData | null }
  | { cmd: "newPhrase"; network: string; seed: Uint8Array }
  | { cmd: "round"; recheckPool?: boolean }
  | { cmd: "newSession" }
  | { cmd: "view" }
  | { cmd: "snapshot" }
  | { cmd: "parseAddress"; address: string }
  | { cmd: "transfer"; seed: Uint8Array; recipient: string; amount: string; fee: string }
  | { cmd: "unshield"; seed: Uint8Array; to: string; amount: string; fee: string }
  | { cmd: "prepareShield"; fromPubKey: string; vIn: string; fee: string }
  | { cmd: "completeShield"; sig: string }
  | { cmd: "resubmit"; paymentId: string }
  | { cmd: "soleCopy"; userConfirmedTheStatement: true }
);

/** Distributes Omit over the union of requests (for the host's `ask`). */
export type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export interface WorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  trap?: boolean;
  address?: string;
  fingerprint?: string;
  view?: ShieldViewModel | null;
  session?: SessionData | null;
  made?: boolean;
  parsed?: { address: string; pk: string; fingerprint: string };
  done?: boolean;
  result?: PaymentResult;
  shield?: { status: "sign"; signing_bytes: string } | PaymentResult;
}
