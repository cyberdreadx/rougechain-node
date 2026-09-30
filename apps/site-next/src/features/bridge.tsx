import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { FeatureArea } from "./types";

// Loaded on demand: viem, QR codes and the bridge flows stay out of the landing bundle.
const BridgePage = lazy(() => import("../bridge/BridgePage"));

function BridgeLoading() {
  const { t } = useTranslation("common");
  return (
    <main id="main" className="app-main">
      <div className="container">
        <p className="muted">{t("loading")}</p>
      </div>
    </main>
  );
}

/** Bridge (Base + BTC deposits/withdrawals). Owner: the bridge area. Same path as apps/web. */
export const bridgeArea: FeatureArea = {
  routes: [
    <Route
      key="bridge"
      path="/bridge"
      element={
        <Suspense fallback={<BridgeLoading />}>
          <BridgePage />
        </Suspense>
      }
    />,
  ],
  headerProduct: (pathname) => (pathname === "/bridge" || pathname.startsWith("/bridge/") ? "Bridge" : null),
};
