import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0", // Use IPv4 to avoid localhost connection issues on Windows
    port: 5173,       // Vite default; 8080 may be blocked by other software
    hmr: {
      overlay: false,
    },
    proxy: {
      // Proxy GeckoTerminal API to avoid CORS issues
      "/gecko-api": {
        target: "https://api.geckoterminal.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gecko-api/, "/api/v2"),
        secure: true,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
}));
