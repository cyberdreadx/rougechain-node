import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { applySiteHead, siteHead } from "./src/pages/site-head";

// Page head per build: the main site, explorer.rougechain.io (VITE_APP_MODE=explorer), and a
// testnet-pinned deploy (VITE_NETWORK_LOCK=testnet). The tag logic lives in
// src/pages/site-head.ts (unit-tested); scripts/prerender-og.mjs then specialises it per route.
function siteMeta(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const explorer = (process.env.VITE_APP_MODE ?? env.VITE_APP_MODE) === "explorer";
  const testnet = (process.env.VITE_NETWORK_LOCK ?? env.VITE_NETWORK_LOCK) === "testnet";
  const head = siteHead({ explorer, testnet });
  return {
    name: "rougechain-site-meta",
    transformIndexHtml(html) {
      return applySiteHead(html, head);
    },
  };
}

// Shielded pool V2 (/shield): off unless VITE_SHIELD_V2_ENABLED=true at build time. For `vite build`
// the value is fixed as a literal so that, when off, the page, its worker and the .wasm are not
// even emitted (dead branch). Dev server and tests read it at run time (vi.stubEnv works).
function shieldFlag(mode: string): string {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return (process.env.VITE_SHIELD_V2_ENABLED ?? env.VITE_SHIELD_V2_ENABLED) === "true" ? "true" : "false";
}

export default defineConfig(({ mode, command }) => ({
  plugins: [react(), tailwindcss(), siteMeta(mode)],
  ...(command === "build" ? { define: { "import.meta.env.VITE_SHIELD_V2_ENABLED": JSON.stringify(shieldFlag(mode)) } } : {}),
  // The shield page's prover is a module worker that imports the wasm-bindgen package (README of
  // core/shield-v2-wasm/browser-test, friction item 1): "iife" workers cannot code-split.
  worker: { format: "es" as const },
  // site-next runs React 19 while apps/web is still on React 18 in the same npm workspace.
  // dedupe makes every import of these (including from packages/brand, ui, chain-readonly)
  // resolve from THIS app's dependencies, so there is exactly one React in the bundle.
  resolve: {
    // react-i18next's use-sync-external-store shim → React 19's built-in hook (src/i18n/…-shim.ts).
    alias: [
      {
        find: /^use-sync-external-store\/shim(\/index\.js)?$/,
        replacement: fileURLToPath(new URL("./src/i18n/use-sync-external-store-shim.ts", import.meta.url)),
      },
    ],
    dedupe: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "framer-motion",
      "lucide-react",
      "dockview-react",
      "dockview",
      "dockview-core",
    ],
  },
}));
