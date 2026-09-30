import { lazy, Suspense, type ReactNode } from "react";
import { Route } from "react-router-dom";
import type { FeatureArea } from "./types";

// Each page is its own chunk: the landing bundle and the explorer build carry none of the DEX.
const Swap = lazy(() => import("../pages/Swap"));
const Pools = lazy(() => import("../pages/Pools"));
const PoolDetail = lazy(() => import("../pages/PoolDetail"));
const Buy = lazy(() => import("../pages/Buy"));

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

/** Paths owned by the swap area (apps/web's /swap, /pools, /pool/:id, /buy + Anders' /swap/* views). */
export function isSwapPath(pathname: string): boolean {
  return (
    pathname === "/swap" ||
    pathname.startsWith("/swap/") ||
    pathname === "/pools" ||
    pathname.startsWith("/pool/") ||
    pathname === "/buy"
  );
}

/** Swap, pools, positions and buy. Owner: the swap area. */
export const swapArea: FeatureArea = {
  routes: [
    <Route key="swap" path="/swap" element={<Page><Swap /></Page>} />,
    <Route key="pools" path="/pools" element={<Page><Pools view="pools" /></Page>} />,
    <Route key="swap-pools" path="/swap/pools" element={<Page><Pools view="pools" /></Page>} />,
    <Route key="swap-positions" path="/swap/positions" element={<Page><Pools view="positions" /></Page>} />,
    <Route key="pool-detail" path="/pool/:poolId" element={<Page><PoolDetail /></Page>} />,
    <Route key="buy" path="/buy" element={<Page><Buy /></Page>} />,
  ],
  headerProduct: (pathname) => (isSwapPath(pathname) ? "Swap" : null),
};
