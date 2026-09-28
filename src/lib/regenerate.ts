/**
 * Data layer for RougeChain Regenerate.
 *
 * The treasury is a dedicated, public RougeChain wallet (REGEN_TREASURY_ADDRESS).
 * Everything the dashboard shows is read from the chain: balance, donations in,
 * grants out, and each project's funding (a project is "funded" only when one of
 * its listed grant transactions is found leaving the treasury on-chain).
 *
 * IMPORTANT: no fabricated metrics. Until the address is set, figures render as
 * "not live yet". The seed projects below are clearly-labelled illustrative
 * proposals; none carry funding until real grant transactions exist.
 */

import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";

/**
 * The Regenerate treasury: a dedicated, publicly listed RougeChain wallet. Paste its
 * rouge1… address here and the page goes live: balance, donations, grants and each
 * project's funding are all read from the chain (nothing is typed in by hand).
 * Leave empty until the wallet exists; the page then says so instead of showing numbers.
 */
export const REGEN_TREASURY_ADDRESS = "rouge1yly4449sgnfe8cth6jytyl0qsxxuj8txq0ycnh35cf3cu8n2jm5sz0c0pf";

/** Explorer link for a transaction id. */
export const txUrl = (txId: string) => `/tx/${txId}`;

export type RegenCategoryKey = "ecology" | "infrastructure" | "technology" | "art";

export type RegenStatus = "proposed" | "reviewing" | "funded" | "in_progress" | "completed";

export interface RegenCategory {
  key: RegenCategoryKey;
  title: string;
  blurb: string;
}

export const REGEN_CATEGORIES: RegenCategory[] = [
  { key: "ecology", title: "Local Ecology", blurb: "Mangroves, water restoration, biodiversity, reforestation." },
  { key: "infrastructure", title: "Regenerative Infrastructure", blurb: "Solar, water capture, gardens, composting, community energy." },
  { key: "technology", title: "Open Technology", blurb: "Environmental sensors, mapping tools, public-infrastructure software, open-source climate tech." },
  { key: "art", title: "Art + Community", blurb: "Public installations, education, workshops, community spaces and solarpunk projects." },
];

export interface Milestone {
  title: string;
  done: boolean;
}

export interface RegenProject {
  id: string;
  name: string;
  location: string;
  category: RegenCategoryKey;
  /** Requested funding in XRGE. `null` = not yet disclosed. */
  requestedXrge: number | null;
  status: RegenStatus;
  description: string;
  milestones: Milestone[];
  /** Proof / evidence of completed work — only set once it exists. */
  evidenceUrl?: string;
  /**
   * Transaction ids of the grant payments for this project. A payment only counts if
   * it is found on-chain as an XRGE transfer OUT of the treasury; the amount shown is
   * the on-chain amount, never a number typed here.
   */
  fundingTxIds?: string[];
}

/** One XRGE movement in or out of the treasury, as recorded on-chain. */
export interface TreasuryTx {
  txId: string;
  direction: "in" | "out";
  amountXrge: number;
  /** The other side: sender for donations, recipient for grants. */
  counterparty: string;
  blockHeight: number;
  /** Unix ms. */
  time: number;
}

export interface TreasuryLedger {
  address: string;
  balanceXrge: number;
  receivedXrge: number;
  deployedXrge: number;
  /** Newest first. */
  txs: TreasuryTx[];
}

export interface TreasuryStats {
  /** All `null` until wired to real on-chain data — rendered as "Coming Soon". */
  balanceXrge: number | null;
  projectsFunded: number | null;
  totalDeployedXrge: number | null;
  activeTerritories: number | null;
}

const EMPTY_TREASURY: TreasuryStats = {
  balanceXrge: null,
  projectsFunded: null,
  totalDeployedXrge: null,
  activeTerritories: null,
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Read the treasury wallet straight from the chain: balance plus every XRGE transfer
 * in (donations) and out (grants). Returns null when no treasury address is set or
 * the node can't be reached — callers then show "not live yet", never guessed numbers.
 *
 * Note: the node's address-history endpoint scans the most recent 500 blocks. Blocks
 * are only produced when there are transactions, so that covers a long history today;
 * move this to an indexer if the chain gets busy.
 */
export async function getTreasuryLedger(): Promise<TreasuryLedger | null> {
  const address = REGEN_TREASURY_ADDRESS.trim();
  if (!address) return null;
  const base = getCoreApiBaseUrl();
  if (!base) return null;
  const opts = { headers: getCoreApiHeaders(), signal: AbortSignal.timeout(10000) };
  try {
    const [balRes, txRes] = await Promise.all([
      fetch(`${base}/balance/${encodeURIComponent(address)}`, opts),
      fetch(`${base}/address/${encodeURIComponent(address)}/transactions?limit=500`, opts),
    ]);
    if (!balRes.ok || !txRes.ok) return null;
    const bal = await balRes.json();
    const hist = await txRes.json();
    const txs: TreasuryTx[] = [];
    for (const t of (hist?.transactions ?? []) as Array<Record<string, any>>) {
      const tx = t?.tx ?? {};
      const p = tx.payload ?? {};
      if (tx.tx_type !== "transfer") continue;
      const token = p.token_name ?? p.token_symbol ?? "XRGE";
      if (token !== "XRGE") continue;
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const out = t.direction === "out";
      txs.push({
        txId: String(t.txId ?? ""),
        direction: out ? "out" : "in",
        amountXrge: amount,
        counterparty: String(out ? p.to_pub_key_hex ?? "" : tx.from_pub_key ?? ""),
        blockHeight: Number(t.blockHeight ?? 0),
        time: Number(t.blockTime ?? 0),
      });
    }
    txs.sort((a, b) => b.blockHeight - a.blockHeight || b.time - a.time);
    const sum = (d: "in" | "out") => round(txs.filter((x) => x.direction === d).reduce((a, x) => a + x.amountXrge, 0));
    return {
      address,
      balanceXrge: typeof bal?.balance === "number" ? bal.balance : 0,
      receivedXrge: sum("in"),
      deployedXrge: sum("out"),
      txs,
    };
  } catch {
    return null;
  }
}

/** On-chain grant payments for a project: only its listed txs that really left the treasury. */
export function verifiedFunding(project: RegenProject, ledger: TreasuryLedger | null): { xrge: number; txs: TreasuryTx[] } {
  if (!ledger || !project.fundingTxIds?.length) return { xrge: 0, txs: [] };
  const wanted = new Set(project.fundingTxIds);
  const txs = ledger.txs.filter((t) => t.direction === "out" && wanted.has(t.txId));
  return { xrge: round(txs.reduce((a, t) => a + t.amountXrge, 0)), txs };
}

/**
 * Dashboard figures, all derived from the on-chain ledger. `null` (shown as "not live
 * yet") until the treasury address is set and readable.
 */
export function getTreasuryStats(ledger: TreasuryLedger | null, projects: RegenProject[]): TreasuryStats {
  if (!ledger) return EMPTY_TREASURY;
  const funded = projects.filter((p) => verifiedFunding(p, ledger).txs.length > 0);
  return {
    balanceXrge: ledger.balanceXrge,
    projectsFunded: funded.length,
    totalDeployedXrge: ledger.deployedXrge,
    activeTerritories: new Set(funded.map((p) => p.location)).size,
  };
}

/** Whether any project has verified on-chain funding. */
export function hasFundedProjects(projects: RegenProject[], ledger: TreasuryLedger | null): boolean {
  return projects.some((p) => verifiedFunding(p, ledger).txs.length > 0);
}

/**
 * Illustrative candidate proposals for the first territory (Tulum). These describe
 * the KINDS of work Regenerate aims to fund — every one is status "proposed",
 * with no funding tx and no evidence link, so nothing here claims completed impact.
 * Swap for real proposals/on-chain records when the pipeline opens.
 */
export function getProjects(): RegenProject[] {
  return [
    {
      id: "tulum-mangrove-01",
      name: "Mangrove Corridor Restoration",
      location: "Tulum, Quintana Roo, MX",
      category: "ecology",
      requestedXrge: null,
      status: "proposed",
      description:
        "Replant and monitor degraded mangrove sections that buffer the coastline, filter water, and store carbon — with community stewards and open survey data.",
      milestones: [
        { title: "Site survey & baseline", done: false },
        { title: "Community stewards onboarded", done: false },
        { title: "Replanting phase 1", done: false },
        { title: "Public monitoring dashboard", done: false },
      ],
    },
    {
      id: "tulum-cenote-water-02",
      name: "Cenote Water-Quality Sensor Network",
      location: "Tulum, Quintana Roo, MX",
      category: "technology",
      requestedXrge: null,
      status: "proposed",
      description:
        "Low-cost, open-source sensors monitoring the cenote and aquifer system, publishing readings openly so the community can see water health over time.",
      milestones: [
        { title: "Open hardware spec", done: false },
        { title: "Pilot sensors deployed", done: false },
        { title: "Open data feed live", done: false },
      ],
    },
    {
      id: "tulum-community-solar-03",
      name: "Community Solar + Water Capture",
      location: "Tulum, Quintana Roo, MX",
      category: "infrastructure",
      requestedXrge: null,
      status: "proposed",
      description:
        "Shared rooftop solar and rainwater capture for a community space — resilient local infrastructure that keeps running when the grid doesn't.",
      milestones: [
        { title: "Host site agreement", done: false },
        { title: "Install", done: false },
        { title: "Public metering", done: false },
      ],
    },
  ];
}

export const REGEN_STATUS_LABEL: Record<RegenStatus, string> = {
  proposed: "Proposed",
  reviewing: "In review",
  funded: "Funded",
  in_progress: "In progress",
  completed: "Completed",
};
