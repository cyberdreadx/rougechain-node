import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@rougechain/brand/tokens.css";
import "./style.css";

// VITE_APP_MODE=explorer builds explorer.rougechain.io (the Explorer as a standalone site);
// anything else builds the main site. Vite inlines the value, so each build loads only its app.
const Root =
  import.meta.env.VITE_APP_MODE === "explorer"
    ? lazy(() => import("./ExplorerSite"))
    : lazy(() => import("./App"));
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
