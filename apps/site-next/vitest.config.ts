import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export default defineConfig((env) =>
  mergeConfig(
    viteConfig(env),
    defineConfig({
      // Tests only: point React at this app's React 19 copy by absolute path (vitest resolves some
      // imports outside Vite's dedupe, which would otherwise pick up the repo root's React 18).
      resolve: {
        alias: [
          // @testing-library/react is shared with apps/web at the repo root; use its ES-module
          // build so its react / react-dom imports go through the aliases below.
          {
            find: /^@testing-library\/react$/,
            replacement: path.join(
              repoRoot,
              "node_modules/@testing-library/react/dist/@testing-library/react.esm.js",
            ),
          },
          {
            find: /^react$/,
            replacement: path.join(here, "node_modules/react/index.js"),
          },
          {
            find: /^react\/(.*)$/,
            replacement: path.join(here, "node_modules/react/$1"),
          },
          {
            find: /^react-dom$/,
            replacement: path.join(here, "node_modules/react-dom/index.js"),
          },
          {
            find: /^react-dom\/(.*)$/,
            replacement: path.join(here, "node_modules/react-dom/$1"),
          },
        ],
      },
      test: {
        environment: "jsdom",
        testTimeout: 120_000,
        globals: true,
        dir: repoRoot,
        include: [
          "apps/site-next/src/**/*.test.{ts,tsx}",
          "packages/{brand,ui,chain-readonly}/**/*.test.{ts,tsx}",
        ],
        setupFiles: [path.join(here, "src/test-setup.ts")],
        // Process React-rendering test libraries through Vite so resolve.dedupe gives them this
        // app's React 19 (Node resolution alone would find the repo root's React 18 for apps/web).
        server: {
          deps: {
            inline: [
              /@testing-library\//,
              /react-router/,
              /framer-motion/,
              /lucide-react/,
              /@tanstack\//,
              /dockview/,
              /react-i18next/,
            ],
          },
        },
      },
    }),
  ),
);
