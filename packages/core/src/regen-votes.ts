/**
 * RougeChain Regenerate — community votes client.
 *
 * Interim governance for the Regenerate treasury, hosted by the node (off-consensus)
 * until on-chain governance ships. Votes are signed by the voter's wallet — locally,
 * or through the RougeChain extension / Qwalla browser — and the node stores each
 * vote with its signature so anyone can recount. Weights come from a balance
 * snapshot taken when the proposal opened.
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { loadUnifiedWallet } from "./unified-wallet";
import { generateNonce, signTransaction, type SignedTransaction, type TransactionPayload } from "./pqc-signer";
import { signViaExtension } from "./extension-bridge";

export type VoteChoice = "yes" | "no" | "abstain";
export type VoteStatus = "open" | "passed" | "failed" | "paid" | "cancelled";

export interface RegenVoteConfig {
  treasury: string | null;
  capBps: number;
  turnoutBps: number;
  defaultDays: number;
  minCreatorXrge: number;
  excluded: string[];
  curators: string[];
}

export interface VoteProposal {
  id: string;
  title: string;
  summary: string;
  link?: string | null;
  territory?: string | null;
  recipient?: string | null;
  requestedXrge?: number | null;
  creator: string;
  createdAtMs: number;
  endsAtMs: number;
  snapshotHeight: number;
  capBps: number;
  turnoutBps: number;
  eligibleVoters: number;
  payoutTxId?: string | null;
  payoutXrge?: number | null;
  cancelled: boolean;
  cancelReason?: string | null;
}

export interface VoteSummary {
  eligibleTotal: number;
  cap: number;
  turnoutNeeded: number;
  yes: number;
  no: number;
  abstain: number;
  turnout: number;
}

export interface VoteEntry {
  proposal: VoteProposal;
  status: VoteStatus;
  tally: { voters: number };
  summaryXrge: VoteSummary;
}

export interface VoterWeight {
  address: string;
  eligible: boolean;
  excluded: boolean;
  weightXrge: number;
  vote: VoteChoice | null;
}

async function getJson<T>(path: string): Promise<T | null> {
  const base = getCoreApiBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, { headers: getCoreApiHeaders(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getVoteConfig(): Promise<RegenVoteConfig | null> {
  return getJson<RegenVoteConfig>("/regen/config");
}

/** All proposals, newest first. null = the node doesn't serve votes (yet) or is unreachable. */
export async function listVoteProposals(): Promise<VoteEntry[] | null> {
  const r = await getJson<{ proposals: VoteEntry[] }>("/regen/proposals");
  return r ? r.proposals : null;
}

export async function getVoterWeight(proposalId: string, who: string): Promise<VoterWeight | null> {
  return getJson<VoterWeight>(`/regen/proposals/${encodeURIComponent(proposalId)}/weight/${encodeURIComponent(who)}`);
}

/** The wallet that would sign, or null if none is connected / it's locked. */
export function currentVoter(): { publicKey: string; label: string } | null {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) return null;
  return { publicKey: w.signingPublicKey, label: w.displayName || "Wallet" };
}

async function sign(payload: Record<string, unknown>): Promise<SignedTransaction> {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) throw new Error("Connect or unlock a wallet to vote.");
  const full = { ...payload, from: w.signingPublicKey, timestamp: Date.now(), nonce: generateNonce() } as unknown as TransactionPayload;
  return w.signingPrivateKey
    ? signTransaction(full, w.signingPrivateKey, w.signingPublicKey)
    : signViaExtension(full, w.signingPublicKey);
}

async function postSigned(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = getCoreApiBaseUrl();
  if (!base) throw new Error("Node not configured.");
  const signed = await sign(payload);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.success === false) throw new Error(String(data.error || `Request failed (${res.status})`));
  return data;
}

export async function castVote(proposalId: string, choice: VoteChoice) {
  return postSigned("/v2/regen/votes", { type: "regen_vote", proposalId, choice });
}

export interface NewProposal {
  title: string;
  summary: string;
  territory?: string;
  recipient?: string;
  requestedXrge?: number;
  link?: string;
  durationDays?: number;
}

export async function openProposal(p: NewProposal) {
  const payload: Record<string, unknown> = { type: "regen_proposal", title: p.title, summary: p.summary };
  if (p.territory) payload.territory = p.territory;
  if (p.recipient) payload.recipient = p.recipient;
  if (p.requestedXrge) payload.requestedXrge = p.requestedXrge;
  if (p.link) payload.link = p.link;
  if (p.durationDays) payload.durationDays = p.durationDays;
  return postSigned("/v2/regen/proposals", payload);
}

export async function recordPayout(proposalId: string, txId: string) {
  return postSigned("/v2/regen/proposals/payout", { type: "regen_payout", proposalId, txId });
}

export function timeLeft(endsAtMs: number, now = Date.now()): string {
  const ms = endsAtMs - now;
  if (ms <= 0) return "closed";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}
