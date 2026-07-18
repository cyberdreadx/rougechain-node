#!/usr/bin/env node
/**
 * Pack-install-import smoke test.
 *
 * Builds the package, `npm pack`s it, installs the resulting tarball into a
 * throwaway directory, and both `import()`s (ESM) and `require()`s (CJS) it.
 *
 * This catches the class of bug that a local `npm run build` and the repo's
 * own node_modules cannot see: a broken publish that fails on a *fresh
 * consumer install* — e.g. a subpath import like `@noble/hashes/sha2` that
 * the installed dependency version only exposes as `./sha2.js`
 * (ERR_PACKAGE_PATH_NOT_EXPORTED). See sdk v1.3.1 -> v1.3.2.
 *
 * Wired as `prepublishOnly`, so `npm publish` cannot ship a package that
 * doesn't load.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = process.cwd();
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });

let tmp;
try {
  console.log("[verify-pack] building…");
  run("npm run build", { cwd: pkgDir });

  console.log("[verify-pack] packing…");
  const tarball = run("npm pack --silent", { cwd: pkgDir }).trim().split("\n").pop();
  const tarballPath = join(pkgDir, tarball);

  tmp = mkdtempSync(join(tmpdir(), "sdk-verify-"));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "verify-consumer", private: true, type: "module" })
  );

  console.log(`[verify-pack] installing ${tarball} into a clean consumer…`);
  run(`npm install "${tarballPath}"`, { cwd: tmp });

  const pkgName = JSON.parse(run("npm pkg get name", { cwd: pkgDir })) || "@rougechain/sdk";

  console.log("[verify-pack] importing (ESM)…");
  run(`node --input-type=module -e "await import('${pkgName}')"`, { cwd: tmp });

  console.log("[verify-pack] requiring (CJS)…");
  run(`node --input-type=commonjs -e "require('${pkgName}')"`, { cwd: tmp });

  // Clean up the tarball left in the package dir by `npm pack`
  for (const f of readdirSync(pkgDir)) {
    if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
  }

  console.log("[verify-pack] ✅ package installs, imports (ESM), and requires (CJS) cleanly.");
} catch (err) {
  console.error("[verify-pack] ❌ FAILED — the packed package does not load in a fresh install.");
  console.error(err.stdout?.toString?.() || "");
  console.error(err.stderr?.toString?.() || err.message);
  process.exit(1);
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
