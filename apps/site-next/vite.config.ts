import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Page title/description per build: the main site or explorer.rougechain.io (VITE_APP_MODE=explorer).
function siteMeta(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const explorer =
    (process.env.VITE_APP_MODE ?? env.VITE_APP_MODE) === "explorer";
  const title = explorer
    ? "RougeChain Explorer — blocks, transactions, addresses and tokens"
    : "RougeChain — Post-quantum from genesis.";
  const description = explorer
    ? "Explore RougeChain, the post-quantum Layer 1: blocks, transactions, addresses, tokens, NFTs and contracts."
    : "RougeChain — a post-quantum Layer 1 blockchain built on NIST-standardized lattice cryptography.";
  return {
    name: "rougechain-site-meta",
    transformIndexHtml(html) {
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(
          /(<meta\s+name="description"\s+content=")[^"]*(")/,
          `$1${description}$2`,
        );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), siteMeta(mode)],
  // site-next runs React 19 while apps/web is still on React 18 in the same npm workspace.
  // dedupe makes every import of these (including from packages/brand, ui, chain-readonly)
  // resolve from THIS app's dependencies, so there is exactly one React in the bundle.
  resolve: {
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
