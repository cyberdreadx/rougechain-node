#!/usr/bin/env node
/**
 * Pack-install-launch smoke test for the MCP server.
 *
 * Builds the package, `npm pack`s it, installs the tarball into a throwaway
 * dir, then spawns the installed binary and waits for it to report that it
 * started (it's a stdio server, so you can't just import it — importing runs
 * main() and blocks on the transport).
 *
 * Catches fresh-consumer load failures — a bad dependency subpath, a missing
 * export, or a runtime crash on boot — that a local `npm run build` and the
 * repo's cached node_modules cannot see. Wired as `prepublishOnly`, so a
 * package that doesn't boot can't ship. (See the sdk v1.3.1 regression.)
 */
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = process.cwd();
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });

const READY = "Server started";
const TIMEOUT_MS = 15000;

let tmp;
try {
  console.log("[verify-pack] building…");
  run("npm run build", { cwd: pkgDir });

  console.log("[verify-pack] packing…");
  const tarball = run("npm pack --silent", { cwd: pkgDir }).trim().split("\n").pop();
  const tarballPath = join(pkgDir, tarball);

  tmp = mkdtempSync(join(tmpdir(), "mcp-verify-"));
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "verify-consumer", private: true, type: "module" })
  );

  console.log(`[verify-pack] installing ${tarball} into a clean consumer…`);
  run(`npm install "${tarballPath}"`, { cwd: tmp });

  const pkgName = JSON.parse(run("npm pkg get name", { cwd: pkgDir }));
  const entry = join(tmp, "node_modules", pkgName, "dist", "index.js");

  console.log("[verify-pack] launching the installed server…");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: tmp,
      env: { ...process.env, ROUGECHAIN_URL: "https://api.rougechain.io" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not report "${READY}" within ${TIMEOUT_MS}ms\n${err}`));
    }, TIMEOUT_MS);

    const onData = (buf) => {
      err += buf.toString();
      if (err.includes(READY)) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!err.includes(READY)) {
        reject(new Error(`server exited (code ${code}) before starting\n${err}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  // Clean up the tarball left in the package dir by `npm pack`
  for (const f of readdirSync(pkgDir)) {
    if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
  }

  console.log("[verify-pack] ✅ package installs and the server boots cleanly.");
} catch (err) {
  console.error("[verify-pack] ❌ FAILED — the packed package does not boot in a fresh install.");
  console.error(err.stdout?.toString?.() || "");
  console.error(err.stderr?.toString?.() || err.message);
  process.exit(1);
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
