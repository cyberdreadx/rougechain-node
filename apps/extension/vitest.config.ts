import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests for the extension's wallet/crypto libraries only (no React, no browser): plain Node,
// with an in-memory chrome.storage shim installed by the tests that need it (test/chrome-shim.ts).
export default defineConfig({
    resolve: {
        alias: { "@": path.resolve(__dirname, "./src") },
    },
    test: {
        environment: "node",
        globals: false,
        include: ["test/**/*.test.ts"],
    },
});
