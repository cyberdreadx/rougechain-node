import { lazy, Suspense, type ReactNode } from "react";
import { Route } from "react-router-dom";
import type { FeatureArea } from "./types";

// Each page loads on demand (keeps core's signing / PQC code out of the landing bundle).
const Validators = lazy(() => import("../pages/Validators"));
const GenesisValidators = lazy(() => import("../pages/GenesisValidators"));
const Node = lazy(() => import("../pages/Node"));
const Agents = lazy(() => import("../pages/Agents"));
const Status = lazy(() => import("../pages/Status"));
const Regenerate = lazy(() => import("../pages/Regenerate"));
const Privacy = lazy(() => import("../pages/Privacy"));

function Page({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <main id="main" className="app-main">
          <div className="container">
            <p className="muted">Loading…</p>
          </div>
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

/** Paths this area owns (same as apps/web). /buy is the swap area's; /contracts is the Explorer's. */
export const PAGES_PATHS = ["/validators", "/genesis-validators", "/node", "/agents", "/status", "/regenerate", "/privacy"];

/**
 * Header choice:
 *  - "Validators" app header for /validators and /genesis-validators (the staking app);
 *  - "Network" app header for /status: live chain telemetry, like the Explorer (registry: Network Status);
 *  - marketing header (null) for /node, /agents, /regenerate, /privacy: they are guides,
 *    program and legal pages read like the landing site, not tools with local navigation.
 */
export function pagesHeaderProduct(pathname: string): string | null {
  if (pathname === "/validators" || pathname === "/genesis-validators") return "Validators";
  if (pathname === "/status") return "Network";
  return null;
}

/** Validators, staking and the remaining pages (node, agents, regenerate, status, privacy, genesis). */
export const pagesArea: FeatureArea = {
  routes: [
    <Route key="validators" path="/validators" element={<Page><Validators /></Page>} />,
    <Route key="genesis-validators" path="/genesis-validators" element={<Page><GenesisValidators /></Page>} />,
    <Route key="node" path="/node" element={<Page><Node /></Page>} />,
    <Route key="agents" path="/agents" element={<Page><Agents /></Page>} />,
    <Route key="status" path="/status" element={<Page><Status /></Page>} />,
    <Route key="regenerate" path="/regenerate" element={<Page><Regenerate /></Page>} />,
    <Route key="privacy" path="/privacy" element={<Page><Privacy /></Page>} />,
  ],
  headerProduct: pagesHeaderProduct,
};
