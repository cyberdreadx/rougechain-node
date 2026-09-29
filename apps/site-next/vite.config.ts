import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// site-next runs React 19 while apps/web is still on React 18 in the same npm workspace.
// dedupe makes every import of these (including from packages/brand, ui, chain-readonly)
// resolve from THIS app's dependencies, so there is exactly one React in the bundle.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "framer-motion",
      "lucide-react",
      "@danfessler/trellis",
      "@danfessler/trellis-react",
    ],
  },
});
