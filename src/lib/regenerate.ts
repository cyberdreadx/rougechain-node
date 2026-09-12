/**
 * Data layer for RougeChain Regenerate.
 *
 * Presentation (components/pages) is kept deliberately separate from data so these
 * values can later be sourced from RougeChain RPC / the REST API / on-chain
 * contracts. To go live, replace the bodies of `getTreasuryStats` and
 * `getProjects` with real fetches — the UI needs no changes.
 *
 * IMPORTANT: no fabricated metrics. Anything not yet real is `null` and renders as
 * "Coming Soon". The seed projects below are clearly-labelled *illustrative
 * proposals* (status "proposed") — none are presented as funded, and none carry a
 * funding tx or evidence link until those actually exist.
 */

import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";

/**
 * The regeneration treasury's on-chain address. Set this to the rouge1 address
 * (or public-key hex) that holds the Regenerate treasury and the dashboard's
 * "Treasury Balance" tile goes live automatically. Left empty → the tile stays
 * "Coming Soon" (no fabricated numbers).
 */
export const REGEN_TREASURY_ADDRESS = "";

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
  /** On-chain funding transaction hash — only set once funding is deployed. */
  txHash?: string;
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

/**
 * Treasury figures.
 *
 * - `balanceXrge` is read LIVE from the chain when `REGEN_TREASURY_ADDRESS` is set
 *   (via the core API `/balance/<addr>`); otherwise it stays `null` → "Coming Soon".
 * - The remaining fields (projects funded, total deployed, active territories) need
 *   an indexer/contract that doesn't exist yet, so they stay `null` — never faked.
 *   Populate them here once that data source is available.
 */
export async function getTreasuryStats(): Promise<TreasuryStats> {
  if (!REGEN_TREASURY_ADDRESS) return EMPTY_TREASURY;
  try {
    const base = getCoreApiBaseUrl();
    if (!base) return EMPTY_TREASURY;
    const res = await fetch(`${base}/balance/${REGEN_TREASURY_ADDRESS}`, {
      headers: getCoreApiHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return EMPTY_TREASURY;
    const data = await res.json();
    const bal = typeof data?.balance === "number" ? data.balance : null;
    return { ...EMPTY_TREASURY, balanceXrge: bal };
  } catch {
    return EMPTY_TREASURY;
  }
}

/**
 * Whether any project has real, on-chain funding yet. Used by the UI to avoid
 * implying impact that hasn't happened.
 */
export function hasFundedProjects(projects: RegenProject[]): boolean {
  return projects.some((p) => p.status === "funded" || p.status === "in_progress" || p.status === "completed" || !!p.txHash);
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
