import { defineConfig } from "vitest/config";

// Core is framework-free: tests run in plain Node (no jsdom, no React plugin).
// Tests that need Web Storage install an in-memory shim themselves (test/storage-shim.ts).
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
  },
});
