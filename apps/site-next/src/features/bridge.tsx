import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import type { FeatureArea } from "./types";

// Loaded on demand: viem, QR codes and the bridge flows stay out of the landing bundle.
const BridgePage = lazy(() => import("../bridge/BridgePage"));

/** Bridge (Base + BTC deposits/withdrawals). Owner: the bridge area. Same path as apps/web. */
export const bridgeArea: FeatureArea = {
  routes: [
    <Route
      key="bridge"
      path="/bridge"
      element={
        <Suspense
          fallback={
            <main id="main" className="app-main">
              <div className="container">
                <p className="muted">Loading…</p>
              </div>
            </main>
          }
        >
          <BridgePage />
        </Suspense>
      }
    />,
  ],
  headerProduct: (pathname) => (pathname === "/bridge" || pathname.startsWith("/bridge/") ? "Bridge" : null),
};
