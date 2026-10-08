// End-to-end run of the /shield page in headless Chromium against MOCKED nodes (never a real
// node: every request that does not go to 127.0.0.1 is aborted).
//
//   1. three mocked nodes on 127.0.0.1 (src/shield/testing/mock-chain.mjs, the node's real response
//      shapes; the pool values from an observer state of the real wasm package); a submitted
//      envelope is mined into the next block at once;
//   2. a static server for a flag-ON build (built by this script into a temp dir, with
//      VITE_CORE_API_URL pointing at mocked node A);
//   3. the page: import the wallet vector phrase (wallet-2) through the wallet UI, configure the
//      three loopback nodes, confirm the "no other copy" statement while the first state check
//      waits for a silent node, then shield → private transfer → unshield, each proved in the
//      page's worker; screenshots of the states.
//
// Usage (from apps/site-next):
//   LD_LIBRARY_PATH=~/pw-check/libs/usr/lib/x86_64-linux-gnu \
//   PLAYWRIGHT=~/pw-check/node_modules/playwright/index.mjs \
//   SHOTS=/path/to/screens nice -n 19 node scripts/shield-e2e.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pkg from "../src/shield/vendor/quantum_vault_shield_v2_wasm.js";
import { MockChain, nodeAnswer, inactiveListing, inactiveStats, bodyFields } from "../src/shield/testing/mock-chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const repo = path.resolve(site, "../..");
const SHOTS = process.env.SHOTS ?? "/tmp/shield-shots";
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
mkdirSync(SHOTS, { recursive: true });

const PORTS = { site: 47180, a: 47181, b: 47182, c: 47183 };
const NODE_ORIGINS = [PORTS.a, PORTS.b, PORTS.c].map((p) => `http://127.0.0.1:${p}`);
const t0 = Date.now();
const timings = {};
const mark = (k) => (timings[k] = ((Date.now() - t0) / 1000).toFixed(1) + " s");
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---- the build (flag on) ---------------------------------------------------------------------
const dist = "/tmp/shield-build-e2e";
if (!process.env.SKIP_BUILD) {
  rmSync(dist, { recursive: true, force: true });
  const r = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: site,
    stdio: "inherit",
    env: { ...process.env, VITE_SHIELD_V2_ENABLED: "true", VITE_CORE_API_URL: `${NODE_ORIGINS[0]}/api` },
  });
  if (r.status !== 0) throw new Error("vite build failed");
}
mark("built");

// ---- the mocked nodes --------------------------------------------------------------------------
pkg.initSync({ module: readFileSync(path.join(site, "src/shield/vendor/quantum_vault_shield_v2_wasm_bg.wasm")) });
const obsSeed = new Uint8Array(64).fill(7);
const obs = JSON.parse(pkg.shielded_address(obsSeed));
const chain = new MockChain({ api: pkg, observerAddress: obs.address, observerKey: pkg.export_scan_key(obsSeed, true), activation: 3, chainId: "rougechain-devnet-1" });
await chain.advanceTo(10);
const mode = { inactive: false, silentStats: new Set() };
const submitted = [];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
async function handleNode(i, req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  let body = "";
  for await (const c of req) body += c;
  const url = `http://127.0.0.1${req.url}`;
  const u = new URL(url);
  if (mode.inactive && u.pathname === "/api/shield-v2/notes") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inactiveListing(Number(u.searchParams.get("since")), chain.tip)));
  if (mode.inactive && u.pathname === "/api/shield-v2/stats") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inactiveStats(chain.tip)));
  if (u.pathname === "/api/shield-v2/stats" && mode.silentStats.has(i)) return res.socket.destroy();
  if (u.pathname === "/api/tx/broadcast" && req.method === "POST") {
    try {
      const env = JSON.parse(body);
      const b = env?.payload?.shield_v2_body;
      if (typeof b !== "string" || b.length !== 5092) throw new Error("not a V2 envelope");
      if (!submitted.some((s) => s.body === b)) {
        const f = bodyFields(b);
        if (f.expiry_height < chain.tip + 1) throw new Error("expired");
        submitted.push({ body: b, type: env.tx_type, node: i });
        if (env.tx_type === "shield_v2") chain.nonces.set(env.from_pub_key, (chain.nonces.get(env.from_pub_key) ?? 0) + 1);
        const h = await chain.addBlock([b]);
        log(`node ${i}: mined ${env.tx_type} at ${h}`);
      }
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, error: null }));
    } catch (e) {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: false, error: String(e.message) }));
    }
  }
  const a = nodeAnswer(chain, url, { method: req.method, body });
  res.writeHead(a.status, { "Content-Type": "application/json" }).end(a.text);
}
const servers = [PORTS.a, PORTS.b, PORTS.c].map((p, i) => createServer((q, r) => void handleNode(i, q, r)).listen(p, "127.0.0.1"));

// ---- the static site ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const wasmFetches = [];
const siteServer = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = path.join(dist, "index.html");
  if (f.endsWith(".wasm")) wasmFetches.push(p);
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(PORTS.site, "127.0.0.1");
const BASE = `http://127.0.0.1:${PORTS.site}`;

// ---- the browser -----------------------------------------------------------------------------
const keys = JSON.parse(readFileSync(path.join(repo, "core/shield-v2/vectors/wallet/keys.json"), "utf8"));
const txs = JSON.parse(readFileSync(path.join(repo, "core/shield-v2/vectors/wallet/transactions.json"), "utf8"));
const w2 = keys.wallets.find((w) => w.name === "wallet-2");
const w1 = keys.wallets.find((w) => w.name === "wallet-1");
const unshieldTo = txs.transactions.find((t) => t.tx_type === "unshield_v2").recipient_address;

const browser = await chromium.launch();
const results = { pass: [], fail: [] };
const check = (ok, what) => (ok ? results.pass : results.fail).push(what) && log(ok ? "PASS" : "FAIL", what);
const pageErrors = [];
const blocked = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1" || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    blocked.push(`${u.origin}${u.pathname}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && log("console:", m.text()));
  page.on("worker", (w) => log("worker started:", w.url()));
  globalThis.__page = page;
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

  // import the vector phrase through the wallet UI
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.locator("textarea:visible").first().fill(w2.recovery_phrase);
  await page.getByRole("button", { name: "Import wallet" }).click();
  const pw = page.locator('input[type="password"]');
  await pw.first().waitFor({ timeout: 60_000 });
  await pw.nth(0).fill("correct horse battery");
  await pw.nth(1).fill("correct horse battery");
  await pw.nth(1).press("Enter");
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith("pqc-unified-wallet-encrypted")), null, { timeout: 120_000 });
  mark("wallet imported");

  // the page with the default node set: read-only (unlock first: a navigation needs the vault password)
  const unlockIfLocked = async () => {
    const unlock = page.getByRole("button", { name: "Unlock", exact: true });
    await page.getByTestId("fingerprint").or(unlock).first().waitFor({ timeout: 60_000 });
    if (await unlock.isVisible()) {
      await page.locator("main input[type=password]").first().fill("correct horse battery");
      await unlock.click();
    }
  };
  await page.goto(`${BASE}/shield`);
  await unlockIfLocked();
  await page.getByTestId("need-three").waitFor({ timeout: 60_000 });
  await page.getByTestId("fingerprint").waitFor({ timeout: 60_000 });
  check((await page.getByTestId("fingerprint").textContent()).replace(/\s/g, "") === w2.address_fingerprint, "the page derives the vector address (fingerprint)");
  await shot("01-read-only-default-nodes");
  mark("page read-only");

  // three loopback nodes; node C's stats silent so the first state check waits
  mode.silentStats.add(2);
  await page.evaluate((origins) => localStorage.setItem("rougechain-shield-v2-nodes:mainnet", JSON.stringify(origins.map((o, i) => ({ origin: o, operator: `mock operator ${i + 1}` })))), NODE_ORIGINS);
  await page.reload();
  await unlockIfLocked();
  await page.getByTestId("state-waiting").waitFor({ timeout: 90_000 });
  await page.getByTestId("restore-panel").waitFor();
  await shot("02-restored-waiting-for-every-node");
  await page.getByRole("button", { name: /I am certain no other copy/ }).click();
  await shot("03-sole-copy-confirmation");
  check(await page.getByRole("button", { name: "Confirm and skip the wait" }).isDisabled(), "confirmation disabled until ticked");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm and skip the wait" }).click();
  mode.silentStats.delete(2);
  await page.getByTestId("balance-confirmed").waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-panel"] [data-testid="embargo"]'), null, { timeout: 120_000 });
  mark("statement recorded, state confirmed");
  await shot("04-confirmed-empty");

  const pay = async (label, fill, submitName, expectType) => {
    const before = submitted.length;
    const start = Date.now();
    await fill();
    await page.getByRole("button", { name: submitName, exact: true }).click();
    await page.getByText("Building the proof…").waitFor({ timeout: 10_000 }).catch(() => {});
    if (label === "shield") await shot("05-proving");
    await page.getByTestId("payment-result").waitFor({ timeout: 180_000 });
    const proved = (Date.now() - start) / 1000;
    const msg = await page.getByTestId("payment-result").textContent();
    check(/Submitted/.test(msg ?? ""), `${label}: submitted (${msg})`);
    check(submitted.length === before + 1 && submitted[before].type === expectType, `${label}: the node received one ${expectType}`);
    timings[`${label} build+submit`] = proved.toFixed(1) + " s";
    return proved;
  };

  // shield 10 XRGE (fee 1 → a 9 XRGE note)
  await page.getByRole("tab", { name: "Shield", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("form button[type=submit]")?.hasAttribute("disabled"), null, { timeout: 120_000 });
  await pay("shield", () => page.getByLabel("Amount taken from your account (XRGE)").fill("10"), "Shield", "shield_v2");
  await shot("06-shield-pending");
  await page.waitForFunction(() => document.querySelector('[data-testid="balance-confirmed"] strong')?.textContent === "9 XRGE", null, { timeout: 180_000 });
  mark("shield confirmed (9 XRGE)");
  await shot("07-after-shield");

  // private transfer 2 XRGE to the other vector wallet
  await page.getByRole("tab", { name: "Private transfer", exact: true }).click();
  await page.getByLabel("Recipient's shielded address").fill(w1.address);
  await page.getByTestId("recipient-fingerprint").waitFor({ timeout: 30_000 });
  check((await page.getByTestId("recipient-fingerprint").textContent()).replace(/\s/g, "").endsWith(w1.address_fingerprint), "recipient fingerprint shown in full");
  await page.getByLabel("Amount (XRGE)").fill("2");
  await page.waitForFunction(() => !document.querySelector("form button[type=submit]")?.hasAttribute("disabled"), null, { timeout: 120_000 });
  await shot("08-transfer-form");
  await pay("transfer", async () => {}, "Send privately", "shielded_transfer_v2");
  await shot("09-transfer-pending");
  await page.waitForFunction(() => document.querySelector('[data-testid="balance-confirmed"] strong')?.textContent === "6 XRGE", null, { timeout: 180_000 });
  mark("transfer confirmed (6 XRGE)");

  // unshield 1.5 XRGE to a rouge1 address
  await page.getByRole("tab", { name: "Unshield", exact: true }).click();
  await page.getByLabel("Receiving rouge1 address").fill(unshieldTo);
  await page.getByLabel("Amount (XRGE)").fill("1.5");
  await page.waitForFunction(() => !document.querySelector("form button[type=submit]")?.hasAttribute("disabled"), null, { timeout: 120_000 });
  await pay("unshield", async () => {}, "Unshield", "unshield_v2");
  await page.waitForFunction(() => document.querySelector('[data-testid="balance-confirmed"] strong')?.textContent === "3.5 XRGE", null, { timeout: 180_000 });
  mark("unshield confirmed (3.5 XRGE)");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="history-item"]').length === 3, null, { timeout: 120_000 });
  await shot("10-after-unshield-history");
  check((await page.getByTestId("history-item").allTextContents()).every((t) => /paid/.test(t)), "history: all three paid");

  // the pool not active (a second page on the same wallet, the nodes now say "not active")
  mode.inactive = true;
  await page.reload();
  await unlockIfLocked();
  await page.getByTestId("state-inactive").waitFor({ timeout: 90_000 });
  await shot("11-pool-not-active");
  mode.inactive = false;
  check(wasmFetches.length > 0 && wasmFetches.every((p) => p.startsWith("/assets/")), `the .wasm was fetched as a hashed asset (${wasmFetches[0]})`);
} catch (e) {
  results.fail.push(`exception: ${e.message.split("\n")[0]}`);
  log("ERROR", e.message.split("\n")[0]);
  try {
    await globalThis.__page.screenshot({ path: path.join(SHOTS, "zz-failure.png"), fullPage: true });
    log("page text:", (await globalThis.__page.locator("main").innerText()).slice(0, 1500));
  } catch {
    /* no page */
  }
} finally {
  await browser.close();
  for (const s of servers) s.close();
  siteServer.close();
}
check(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);
// Every request to another host was aborted. The shield code must never have tried one:
check(!blocked.some((u) => /shield-v2|tx\/broadcast|account\/.*\/nonce|\/api\/health/.test(u)), `no shielded-pool request left 127.0.0.1`);
log("aborted requests of the rest of the site (not the shield page):", [...new Set(blocked)].join(", ") || "none");
console.log(JSON.stringify({ timings, pass: results.pass.length, fail: results.fail, submitted: submitted.map((s) => s.type), chainTip: chain.tip }, null, 2));
process.exit(results.fail.length ? 1 : 0);
