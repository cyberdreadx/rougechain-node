import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    build: {
        outDir: "dist",
        sourcemap: false,
        minify: "esbuild",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                popup: path.resolve(__dirname, "popup.html"),
                "service-worker": path.resolve(__dirname, "src/background/service-worker.ts"),
                content: path.resolve(__dirname, "src/content/inject.ts"),
                provider: path.resolve(__dirname, "src/content/provider.ts"),
            },
            output: {
                entryFileNames: (chunkInfo) => {
                    if (chunkInfo.name === "service-worker") return "service-worker.js";
                    if (chunkInfo.name === "content") return "content.js";
                    if (chunkInfo.name === "provider") return "provider.js";
                    return "assets/[name]-[hash].js";
                },
            },
        },
    },
});
