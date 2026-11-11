import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { FeatureArea } from "./types";

// Shielded pool V2. The page — and with it the worker and the .wasm — exists only when
// VITE_SHIELD_V2_ENABLED=true: `vite build` turns this test into a literal, and with the flag off
// the dynamic import is a dead branch that is never emitted. Off: the route renders nothing.
const ShieldPage = import.meta.env.VITE_SHIELD_V2_ENABLED === "true" ? lazy(() => import("../shield/ShieldPage")) : null;

function Loading() {
  const { t } = useTranslation("common");
  return (
    <main id="main" className="app-main">
      <div className="container">
        <p className="muted">{t("loading")}</p>
      </div>
    </main>
  );
}

export const shieldArea: FeatureArea = {
  routes: [
    <Route
      key="shield"
      path="/shield"
      element={
        ShieldPage ? (
          <Suspense fallback={<Loading />}>
            <ShieldPage />
          </Suspense>
        ) : null
      }
    />,
  ],
  headerProduct: (pathname) => (ShieldPage && pathname === "/shield" ? "Wallet" : null),
};
