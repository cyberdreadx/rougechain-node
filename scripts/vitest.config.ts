// Relayer unit tests (pure logic, no network). Run from the repo root:
//   npx vitest run --config scripts/vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  test: {
    environment: "node",
    globals: false,
    include: ["scripts/**/*.test.ts"],
  },
});
