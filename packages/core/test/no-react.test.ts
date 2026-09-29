/**
 * @rougechain/core must stay framework-free so React 18 (apps/web) and React 19 (apps/site-next)
 * can both use it. This runs in a plain Node environment (no jsdom) and:
 *  1. makes any import of react / react-dom / JSX runtimes throw, then
 *  2. imports EVERY core entry point (src/*.ts) and checks each one loads.
 * Anything in the module graph pulling React in fails the import.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above everything, so each factory is inline.
vi.mock("react", () => { throw new Error("react was imported into @rougechain/core"); });
vi.mock("react-dom", () => { throw new Error("react-dom was imported into @rougechain/core"); });
vi.mock("react/jsx-runtime", () => { throw new Error("react/jsx-runtime was imported into @rougechain/core"); });
vi.mock("react/jsx-dev-runtime", () => { throw new Error("react/jsx-dev-runtime was imported into @rougechain/core"); });
vi.mock("sonner", () => { throw new Error("sonner was imported into @rougechain/core"); });
vi.mock("lucide-react", () => { throw new Error("lucide-react was imported into @rougechain/core"); });

const entryPoints = import.meta.glob("../src/*.ts");

describe("@rougechain/core has no React in its module graph", () => {
  it("runs in a Node environment without a DOM", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
  });

  it("finds the entry points", () => {
    expect(Object.keys(entryPoints).length).toBeGreaterThanOrEqual(40);
  });

  it.each(Object.keys(entryPoints))("imports %s", async (path) => {
    const mod = (await entryPoints[path]()) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("declares no React dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((d) => /react|sonner/.test(d))).toEqual([]);
  });

  it("sources never import React, sonner, @/ aliases or apps/web", () => {
    for (const path of Object.keys(entryPoints)) {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(src, path).not.toMatch(/from\s+["'](react|react-dom|sonner|lucide-react)(\/[^"']*)?["']/);
      expect(src, path).not.toMatch(/["']@\//);
      expect(src, path).not.toMatch(/(from|import)\s*\(?\s*["'][^"']*apps\/web/);
    }
  });
});
