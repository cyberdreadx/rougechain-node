import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import type { FeatureArea } from "./types";

// The IDE loads on demand: CodeMirror and the local chain (the node's VM as WebAssembly) stay out
// of every other page's bundle.
const IdePage = lazy(() => import("../ide/IdePage"));

export const IDE_PATHS = ["/ide"];

export const ideArea: FeatureArea = {
  routes: [
    <Route
      key="ide"
      path="/ide"
      element={
        <Suspense fallback={<main id="main" className="app-main"><div className="container"><p className="muted">Loading the IDE…</p></div></main>}>
          <IdePage />
        </Suspense>
      }
    />,
  ],
  headerProduct: (pathname) => (IDE_PATHS.includes(pathname) ? "IDE" : null),
};
