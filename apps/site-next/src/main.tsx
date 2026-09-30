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
const explorer = import.meta.env.VITE_APP_MODE === "explorer";
// i18n (and the current language's first namespaces) loads in parallel with the app chunk; the
// app renders once both are in, so the first paint is already in the visitor's language.
const i18nReady = import("./i18n").then((m) =>
  m.initI18n(explorer ? ["common", "explorer"] : ["common", "marketing", "wallet"], {
    explorer,
    testnet: import.meta.env.VITE_NETWORK_LOCK === "testnet",
  }),
);
const Root = lazy(() =>
  Promise.all([explorer ? import("./ExplorerSite") : import("./App"), i18nReady]).then(([m]) => m),
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
