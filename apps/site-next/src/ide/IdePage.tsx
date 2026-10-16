/**
 * RougeChain IDE (/ide): read and edit a contract's Rust source, load its .wasm (a template's
 * prebuilt build, or one you built with cargo), run it on a local test chain in the browser — the
 * node's own contract VM compiled to WebAssembly — and deploy / call it on testnet or mainnet with
 * the connected wallet. Nothing is compiled here: Rust builds happen on your machine.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  CONTRACT_DEPLOY_FEE_XRGE,
  executeContract,
  publishContract,
  queryContract,
  receiptError,
  suggestGasLimit,
  waitForTxReceipt,
  type ContractEvent,
} from "@rougechain/core/contracts";
import { useWallet, useWalletIdentity } from "../wallet/WalletProvider";
import { useRouteSeo } from "../pages/common";
import { analyzeWasm, type WasmAnalysis } from "./analyze";
import { Editor } from "./Editor";
import { TEMPLATES, fillPlaceholders, templateById, type MethodHint, type Template } from "./templates";
import { formatXrge, newLocalChain, parseXrge, type LocalChain } from "./vm";
import "./ide.css";

type Env = "local" | "network";

interface LocalAccount {
  label: string;
  publicKey: string;
  address: string;
}

interface Deployed {
  address: string;
  env: Env;
  /** Network id at deploy time ("mainnet" / "testnet"), for network contracts. */
  network?: string;
  name: string;
  methods: string[];
  hints: Record<string, MethodHint>;
  pending?: boolean;
}

interface LogEntry {
  id: number;
  at: string;
  env: Env;
  title: string;
  ok: boolean | null;
  lines: { label: string; value: string }[];
}

interface Snapshot {
  height: number;
  time: number;
  xrge: { address: string; quanta: string }[];
  tokens: { owner: string; symbol: string; amount: string }[];
  collections: { id: string; symbol: string; name: string; creator: string; minted: number; royalty_bps: number; royalty_recipient: string }[];
  nfts: { collection: string; token_id: number; owner: string; ownerAddress: string; name: string }[];
  contracts: { address: string; code_hash: string; wasm_size: number }[];
}

interface LoadedWasm {
  name: string;
  bytes: Uint8Array;
  analysis: WasmAnalysis;
  /** Set when it is a template's prebuilt build. */
  templateId?: string;
}

const ACCOUNT_NAMES = ["Alice", "Bob", "Carol"];
const START_BALANCE = (10_000n * 1_000_000_000n).toString();
const STORAGE_KEY = "rougechain-ide-edits-v1";

function readEdits(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeEdits(edits: Record<string, string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
  } catch {
    /* storage unavailable: edits live for this visit only */
  }
}

function short(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function pretty(v: unknown): string {
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export default function IdePage() {
  useRouteSeo({
    title: "RougeChain IDE — write, test and deploy WASM contracts",
    description:
      "A browser IDE for RougeChain smart contracts: edit Rust templates, run contracts on a local test chain powered by the node's own VM, and deploy with your wallet.",
  });

  // ── Source ─────────────────────────────────────────────────────────────────────────────────
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const template = templateById(templateId) ?? TEMPLATES[0];
  const [filePath, setFilePath] = useState(template.files[0].path);
  const [edits, setEdits] = useState<Record<string, string>>(readEdits);
  const fileKey = `${template.id}/${filePath}`;
  const file = template.files.find((f) => f.path === filePath) ?? template.files[0];
  const content = edits[fileKey] ?? file.content;
  const edited = edits[fileKey] !== undefined && edits[fileKey] !== file.content;

  const onEdit = useCallback(
    (v: string) => {
      setEdits((prev) => {
        const next = { ...prev, [fileKey]: v };
        writeEdits(next);
        return next;
      });
    },
    [fileKey],
  );

  function resetFile() {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[fileKey];
      writeEdits(next);
      return next;
    });
  }

  function downloadFile() {
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.path.split("/").pop() ?? "lib.rs";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Log ────────────────────────────────────────────────────────────────────────────────────
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);
  const addLog = useCallback((e: Omit<LogEntry, "id" | "at">) => {
    logId.current += 1;
    const entry = { ...e, id: logId.current, at: new Date().toLocaleTimeString() };
    setLog((prev) => [entry, ...prev].slice(0, 200));
    return entry.id;
  }, []);
  const updateLog = useCallback((id: number, patch: Partial<LogEntry>) => {
    setLog((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  // ── Local chain ────────────────────────────────────────────────────────────────────────────
  const chainRef = useRef<LocalChain | null>(null);
  const [chainState, setChainState] = useState<"loading" | "ready" | "error">("loading");
  const [chainError, setChainError] = useState("");
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [accountIdx, setAccountIdx] = useState(0);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [demo, setDemo] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    if (chainRef.current) setSnap(chainRef.current.snapshot() as Snapshot);
  }, []);

  const resetChain = useCallback(async () => {
    setChainState("loading");
    try {
      chainRef.current?.free();
      const chain = await newLocalChain();
      chainRef.current = chain;
      const accs = ACCOUNT_NAMES.map((label) => ({ label, ...(chain.createAccount(START_BALANCE) as { publicKey: string; address: string }) }));
      setAccounts(accs);
      setAccountIdx(0);
      setDemo({});
      setDeployed((prev) => prev.filter((d) => d.env !== "local"));
      setChainState("ready");
      setSnap(chain.snapshot() as Snapshot);
    } catch (e) {
      setChainError(e instanceof Error ? e.message : String(e));
      setChainState("error");
    }
  }, []);

  useEffect(() => {
    void resetChain();
    return () => {
      chainRef.current?.free();
      chainRef.current = null;
    };
  }, [resetChain]);

  const account = accounts[accountIdx];
  const labelOf = useCallback(
    (addr: string) => {
      const a = accounts.find((x) => x.address === addr || x.publicKey === addr);
      if (a) return a.label;
      return short(addr, 8, 4);
    },
    [accounts],
  );

  // ── Environment ────────────────────────────────────────────────────────────────────────────
  const [env, setEnv] = useState<Env>("local");
  const wallet = useWallet();
  const identity = useWalletIdentity();
  const networkName = wallet.network === "mainnet" ? "Mainnet" : "Testnet";
  const signerKey = identity.connected ? wallet.publicKey : null;
  const me = env === "local" ? account?.address ?? "" : identity.address ?? "";

  // ── WASM ───────────────────────────────────────────────────────────────────────────────────
  const [wasm, setWasm] = useState<LoadedWasm | null>(null);
  const [wasmError, setWasmError] = useState("");

  const loadTemplateWasm = useCallback(async (t: Template) => {
    setWasmError("");
    try {
      const res = await fetch(t.wasmUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      setWasm({ name: t.artifact, bytes, analysis: await analyzeWasm(bytes), templateId: t.id });
    } catch (e) {
      setWasm(null);
      setWasmError(`Could not load the prebuilt ${t.artifact}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadTemplateWasm(template);
  }, [template, loadTemplateWasm]);

  function pickTemplate(id: string) {
    const t = templateById(id);
    if (!t) return;
    setTemplateId(id);
    setFilePath(t.files[0].path);
  }

  async function onUpload(f: File | undefined) {
    if (!f) return;
    setWasmError("");
    const bytes = new Uint8Array(await f.arrayBuffer());
    setWasm({ name: f.name, bytes, analysis: await analyzeWasm(bytes) });
  }

  const hintsFor = (w: LoadedWasm | null): Record<string, MethodHint> => (w?.templateId ? templateById(w.templateId)?.methods ?? {} : {});

  // ── Deploy ─────────────────────────────────────────────────────────────────────────────────
  const [deployed, setDeployed] = useState<Deployed[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [atAddress, setAtAddress] = useState("");

  function deployLocal() {
    const chain = chainRef.current;
    if (!chain || !wasm || !account) return;
    try {
      const d = chain.deploy(account.publicKey, wasm.bytes) as { address: string; codeHash: string; size: number };
      setDeployed((prev) => [{ address: d.address, env: "local", name: wasm.name, methods: wasm.analysis.methods, hints: hintsFor(wasm) }, ...prev]);
      addLog({ env: "local", title: `Deployed ${wasm.name}`, ok: true, lines: [
        { label: "address", value: d.address },
        { label: "deployer", value: `${account.label} (${account.address})` },
        { label: "code hash", value: d.codeHash },
        { label: "size", value: kb(d.size) },
      ] });
    } catch (e) {
      addLog({ env: "local", title: `Deploy ${wasm.name}`, ok: false, lines: [{ label: "error", value: e instanceof Error ? e.message : String(e) }] });
    }
    refresh();
  }

  async function deployNetwork() {
    if (!wasm) return;
    setConfirming(false);
    setBusy(true);
    const id = addLog({ env: "network", title: `Deploy ${wasm.name} on ${networkName}`, ok: null, lines: [{ label: "status", value: "Signing…" }] });
    try {
      const r = await publishContract(wasm.bytes);
      if (!r.success || !r.txId) {
        updateLog(id, { ok: false, lines: [{ label: "error", value: r.error ?? "The node refused the deployment." }] });
        return;
      }
      const address = r.address ?? r.predictedAddress;
      setDeployed((prev) => [{ address, env: "network", network: wallet.network, name: wasm.name, methods: wasm.analysis.methods, hints: hintsFor(wasm), pending: true }, ...prev]);
      updateLog(id, { lines: [{ label: "tx", value: r.txId }, { label: "address", value: address }, { label: "status", value: "Waiting for a block…" }] });
      const receipt = await waitForTxReceipt(r.txId);
      const err = receipt ? receiptError(receipt.status) : null;
      setDeployed((prev) => prev.map((d) => (d.address === address ? { ...d, pending: false } : d)));
      updateLog(id, {
        ok: receipt ? !err : null,
        lines: [
          { label: "tx", value: r.txId },
          { label: "address", value: address },
          { label: "status", value: !receipt ? "Not in a block yet — check the explorer." : err ? `Failed: ${err}` : `In block ${receipt.blockHeight ?? "?"}` },
        ],
      });
    } catch (e) {
      updateLog(id, { ok: false, lines: [{ label: "error", value: e instanceof Error ? e.message : String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  function addAtAddress() {
    const addr = atAddress.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(addr) || !wasm) return;
    setDeployed((prev) => [{ address: addr, env: "network", network: wallet.network, name: wasm.name, methods: wasm.analysis.methods, hints: hintsFor(wasm) }, ...prev]);
    setAtAddress("");
  }

  // ── Calls ──────────────────────────────────────────────────────────────────────────────────
  function callLocal(d: Deployed, method: string, args: string, read: boolean, attachSymbol: string, attachAmount: string) {
    const chain = chainRef.current;
    if (!chain || !account) return;
    const title = `${read ? "Read" : "Call"} ${method} on ${short(d.address, 8, 4)} as ${account.label}`;
    try {
      const r = (read
        ? chain.query(account.publicKey, d.address, method, args)
        : chain.call(account.publicKey, d.address, method, args, attachSymbol || null, attachAmount || null, null)) as {
        success: boolean;
        error?: string;
        return_data?: unknown;
        gas_used?: number;
        events?: ContractEvent[];
        storage_writes?: Record<string, string>;
        block?: number;
      };
      const lines = [];
      if (attachSymbol && attachAmount && !read) lines.push({ label: "paid", value: `${attachSymbol === "XRGE" ? formatXrge(attachAmount) : attachAmount} ${attachSymbol}` });
      if (r.error) lines.push({ label: "error", value: r.error });
      if (r.return_data !== undefined) lines.push({ label: "returned", value: pretty(r.return_data) });
      for (const ev of r.events ?? []) lines.push({ label: `event ${ev.topic}`, value: pretty(ev.data) });
      if (r.storage_writes && Object.keys(r.storage_writes).length) lines.push({ label: "storage", value: `${Object.keys(r.storage_writes).length} key(s) written` });
      lines.push({ label: "gas", value: (r.gas_used ?? 0).toLocaleString() });
      if (!read && r.block) lines.push({ label: "block", value: String(r.block) });
      addLog({ env: "local", title, ok: r.success, lines });
    } catch (e) {
      addLog({ env: "local", title, ok: false, lines: [{ label: "error", value: e instanceof Error ? e.message : String(e) }] });
    }
    refresh();
  }

  async function callNetwork(d: Deployed, method: string, argsText: string, read: boolean, attachSymbol: string, attachAmount: string) {
    let args: unknown;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch (e) {
      addLog({ env: "network", title: `${method}: arguments`, ok: false, lines: [{ label: "error", value: `Not JSON: ${e instanceof Error ? e.message : String(e)}` }] });
      return;
    }
    const attach = attachSymbol && attachAmount ? { symbol: attachSymbol, amount: Number(attachAmount) } : null;
    if (attach && !Number.isSafeInteger(attach.amount)) {
      addLog({ env: "network", title: method, ok: false, lines: [{ label: "error", value: "Payment too large for this client." }] });
      return;
    }
    const id = addLog({ env: "network", title: `${read ? "Read" : "Call"} ${method} on ${short(d.address, 8, 4)} (${networkName})`, ok: null, lines: [{ label: "status", value: read ? "Querying…" : "Checking the call…" }] });
    setBusy(true);
    try {
      const q = await queryContract(d.address, method, args, signerKey ?? undefined, attach);
      const preview = [
        ...(q.error ? [{ label: "error", value: q.error }] : []),
        ...(q.returnData !== undefined ? [{ label: "returned", value: pretty(q.returnData) }] : []),
        ...q.events.map((ev) => ({ label: `event ${ev.topic}`, value: pretty(ev.data) })),
        { label: "gas", value: q.gasUsed.toLocaleString() },
      ];
      if (read || !q.success) {
        updateLog(id, { ok: q.success, lines: read ? preview : [{ label: "status", value: "Not sent: the call would fail." }, ...preview] });
        return;
      }
      updateLog(id, { lines: [{ label: "status", value: "Signing…" }, ...preview] });
      const r = await executeContract(d.address, method, args, suggestGasLimit(q.gasUsed), attach);
      if (!r.success || !r.txId) {
        updateLog(id, { ok: false, lines: [{ label: "error", value: r.error ?? "The node refused the call." }, ...preview] });
        return;
      }
      updateLog(id, { lines: [{ label: "tx", value: r.txId }, { label: "status", value: "Waiting for a block…" }, ...preview] });
      const receipt = await waitForTxReceipt(r.txId);
      const err = receipt ? receiptError(receipt.status) : null;
      updateLog(id, {
        ok: receipt ? !err : null,
        lines: [
          { label: "tx", value: r.txId },
          { label: "status", value: !receipt ? "Not in a block yet — check the explorer." : err ? `Failed: ${err}` : `In block ${receipt.blockHeight ?? "?"}` },
          ...preview,
        ],
      });
    } catch (e) {
      updateLog(id, { ok: false, lines: [{ label: "error", value: e instanceof Error ? e.message : String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  // ── Local tools ────────────────────────────────────────────────────────────────────────────
  function tool(title: string, run: (chain: LocalChain) => string | void) {
    const chain = chainRef.current;
    if (!chain) return;
    try {
      const detail = run(chain);
      addLog({ env: "local", title, ok: true, lines: detail ? [{ label: "result", value: detail }] : [] });
    } catch (e) {
      addLog({ env: "local", title, ok: false, lines: [{ label: "error", value: e instanceof Error ? e.message : String(e) }] });
    }
    refresh();
  }

  function setupDemoNft() {
    if (!account) return;
    const royalty = accounts.find((a) => a.label === "Carol") ?? account;
    tool(`Demo NFT for ${account.label}`, (chain) => {
      const symbol = `ART${(snap?.collections.length ?? 0) + 1}`;
      const col = chain.createCollection(account.publicKey, symbol, "Demo art", 100n, 500, royalty.address);
      const token = chain.mintNft(account.publicKey, col, account.publicKey, `${symbol} #1`);
      setDemo({ collection: col, token: token.toString() });
      return `Collection ${col} (5 % royalty to ${royalty.label}), token #${token} owned by ${account.label}. The list arguments are filled in.`;
    });
  }

  const placeholders = useMemo(() => ({ me, ...demo }), [me, demo]);
  const visibleDeployed = deployed.filter((d) => (env === "local" ? d.env === "local" : d.env === "network" && d.network === wallet.network));
  const myBalance = env === "local" && account && snap ? snap.xrge.find((x) => x.address === account.address)?.quanta ?? "0" : null;
  const [bottomTab, setBottomTab] = useState<"console" | "chain">("console");

  return (
    <main id="main" className="ide">
      <div className="ide-bar">
        <div className="ide-title">
          <h1>RougeChain IDE</h1>
          <span className="ide-badge">Preview</span>
        </div>
        <div className="ide-seg" role="radiogroup" aria-label="Where to run">
          <button type="button" role="radio" aria-checked={env === "local"} className={env === "local" ? "on" : undefined} onClick={() => setEnv("local")}>
            Local test chain
          </button>
          <button type="button" role="radio" aria-checked={env === "network"} className={env === "network" ? "on" : undefined} onClick={() => setEnv("network")}>
            {networkName} <span className="muted">· wallet</span>
          </button>
        </div>
      </div>

      <div className="ide-grid">
        {/* ── Files ── */}
        <aside className="ide-side" aria-label="Contracts">
          <section>
            <h2 className="ide-h">Templates</h2>
            <ul className="ide-templates">
              {TEMPLATES.map((t) => (
                <li key={t.id}>
                  <button type="button" className={t.id === templateId ? "on" : undefined} aria-pressed={t.id === templateId} onClick={() => pickTemplate(t.id)}>
                    <strong>{t.name}</strong>
                    <span>{t.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="ide-build">
            <h2 className="ide-h">Build it yourself</h2>
            <p>Edit the source, then compile on your machine and load the result here.</p>
            <pre className="ide-cmd">
              <code>{`git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node/${template.dir}
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown`}</code>
            </pre>
            <p className="muted">
              Output: <code>target/wasm32-unknown-unknown/release/{template.artifact}</code>
            </p>
          </section>
        </aside>

        {/* ── Editor ── */}
        <section className="ide-code" aria-label="Source">
          <div className="ide-tabs" role="tablist" aria-label="Files">
            {template.files.map((f) => (
              <button key={f.path} type="button" role="tab" aria-selected={f.path === filePath} className={f.path === filePath ? "on" : undefined} onClick={() => setFilePath(f.path)}>
                {f.path}
                {edits[`${template.id}/${f.path}`] !== undefined && edits[`${template.id}/${f.path}`] !== f.content ? <span className="ide-dot" aria-label="edited" /> : null}
              </button>
            ))}
            <span className="ide-tabs-fill" />
            {edited && (
              <button type="button" className="ide-link" onClick={resetFile}>
                Revert
              </button>
            )}
            <button type="button" className="ide-link" onClick={downloadFile}>
              Download
            </button>
          </div>
          <Editor docKey={fileKey} value={content} language={file.path.endsWith(".rs") ? "rust" : "text"} onChange={onEdit} label={`${template.name} — ${file.path}`} />
          <p className="ide-note">Edits are saved in this browser. The prebuilt .wasm is the original template; load your own build to run your changes.</p>
        </section>

        {/* ── Deploy & run ── */}
        <section className="ide-run" aria-label="Deploy and run">
          <div className="ide-card">
            <h2 className="ide-h">Account</h2>
            {env === "local" ? (
              chainState === "ready" ? (
                <>
                  <div className="ide-accounts" role="radiogroup" aria-label="Local account">
                    {accounts.map((a, i) => (
                      <button key={a.address} type="button" role="radio" aria-checked={i === accountIdx} className={i === accountIdx ? "on" : undefined} onClick={() => setAccountIdx(i)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <p className="ide-addr mono" title={account?.address}>
                    {account ? short(account.address, 14, 6) : ""} · {myBalance !== null ? `${formatXrge(myBalance)} XRGE` : ""}
                  </p>
                </>
              ) : chainState === "loading" ? (
                <p className="muted">Starting the local chain…</p>
              ) : (
                <p className="ide-error">The local chain could not start: {chainError}</p>
              )
            ) : signerKey ? (
              <>
                <p className="ide-addr mono" title={identity.address ?? undefined}>{identity.address ? short(identity.address, 14, 6) : "…"}</p>
                <p className="muted">
                  Signs with your wallet on <strong>{networkName}</strong>. Each call costs a gas fee in XRGE.
                </p>
              </>
            ) : (
              <p className="muted">
                {identity.locked ? "Unlock your wallet" : <><Link className="text-link inline" to="/wallet">Open or create a wallet</Link> to deploy</>} on {networkName}. Switch network in the wallet.
              </p>
            )}
          </div>

          <div className="ide-card">
            <h2 className="ide-h">Contract</h2>
            {wasm ? (
              <>
                <p className="ide-wasm">
                  <span className="mono">{wasm.name}</span>
                  <span className="muted">
                    {kb(wasm.analysis.size)} · {wasm.analysis.methods.length} method{wasm.analysis.methods.length === 1 ? "" : "s"}
                    {wasm.templateId ? " · prebuilt" : " · your build"}
                  </span>
                </p>
                {wasm.analysis.problems.length > 0 ? (
                  <ul className="ide-problems">
                    {wasm.analysis.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="ide-ok">Uses {wasm.analysis.imports.length} host function{wasm.analysis.imports.length === 1 ? "" : "s"}, all provided by the node.</p>
                )}
              </>
            ) : (
              <p className={wasmError ? "ide-error" : "muted"}>{wasmError || "Loading…"}</p>
            )}
            <label className="ide-upload">
              <input type="file" accept=".wasm,application/wasm" onChange={(e) => void onUpload(e.target.files?.[0])} />
              Load your .wasm…
            </label>

            {env === "local" ? (
              <button type="button" className="button ide-primary" disabled={!wasm || chainState !== "ready"} onClick={deployLocal}>
                Deploy to local chain
              </button>
            ) : confirming ? (
              <div className={`ide-confirm${wallet.network === "mainnet" ? " mainnet" : ""}`} role="alertdialog" aria-label="Confirm deployment">
                <p>
                  Deploy <span className="mono">{wasm?.name}</span> to <strong>{networkName}</strong> for {CONTRACT_DEPLOY_FEE_XRGE} XRGE?
                  {wallet.network === "mainnet" ? " Contracts can't be changed or removed after deployment." : ""}
                </p>
                <div className="ide-row">
                  <button type="button" className="button ide-primary" disabled={busy} onClick={() => void deployNetwork()}>
                    Deploy for {CONTRACT_DEPLOY_FEE_XRGE} XRGE
                  </button>
                  <button type="button" className="button ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button type="button" className="button ide-primary" disabled={!wasm || !signerKey || busy} onClick={() => setConfirming(true)}>
                  Deploy to {networkName}…
                </button>
                <div className="ide-at">
                  <input
                    className="mono"
                    aria-label="Existing contract address"
                    placeholder="Or use at address (40 hex)"
                    value={atAddress}
                    onChange={(e) => setAtAddress(e.target.value)}
                  />
                  <button type="button" className="button ghost small" disabled={!wasm || !/^[0-9a-fA-F]{40}$/.test(atAddress.trim())} onClick={addAtAddress}>
                    Add
                  </button>
                </div>
              </>
            )}
          </div>

          {visibleDeployed.length === 0 ? (
            <p className="ide-empty muted">Deployed contracts appear here with a form for each method.</p>
          ) : (
            visibleDeployed.map((d) => (
              <DeployedCard
                key={`${d.env}-${d.address}`}
                d={d}
                placeholders={placeholders}
                canRun={env === "local" ? chainState === "ready" && !!account : !!signerKey && !busy}
                onRun={(m, args, read, sym, amt) => (env === "local" ? callLocal(d, m, args, read, sym, amt) : void callNetwork(d, m, args, read, sym, amt))}
                onRemove={() => setDeployed((prev) => prev.filter((x) => x !== d))}
              />
            ))
          )}
        </section>

        {/* ── Console / local chain ── */}
        <section className="ide-bottom" aria-label="Output">
          <div className="ide-tabs" role="tablist" aria-label="Output">
            <button type="button" role="tab" aria-selected={bottomTab === "console"} className={bottomTab === "console" ? "on" : undefined} onClick={() => setBottomTab("console")}>
              Console {log.length ? <span className="ide-count">{log.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={bottomTab === "chain"} className={bottomTab === "chain" ? "on" : undefined} onClick={() => setBottomTab("chain")}>
              Local chain {snap ? <span className="ide-count">#{snap.height}</span> : null}
            </button>
            <span className="ide-tabs-fill" />
            {bottomTab === "console" ? (
              log.length > 0 && (
                <button type="button" className="ide-link" onClick={() => setLog([])}>
                  Clear
                </button>
              )
            ) : (
              <button type="button" className="ide-link" onClick={() => void resetChain()}>
                Reset chain
              </button>
            )}
          </div>
          <div className="ide-bottom-body">
            {bottomTab === "console" ? (
              <Console log={log} />
            ) : (
              <ChainPanel
                snap={snap}
                accounts={accounts}
                account={account}
                labelOf={labelOf}
                template={template}
                onDemoNft={setupDemoNft}
                tool={tool}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function DeployedCard({ d, placeholders, canRun, onRun, onRemove }: {
  d: Deployed;
  placeholders: Record<string, string>;
  canRun: boolean;
  onRun: (method: string, args: string, read: boolean, attachSymbol: string, attachAmount: string) => void;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ide-card ide-deployed">
      <div className="ide-deployed-head">
        <span className={`ide-env ${d.env}`}>{d.env === "local" ? "Local" : d.network === "mainnet" ? "Mainnet" : "Testnet"}</span>
        <button
          type="button"
          className="ide-addr-btn mono"
          title="Copy address"
          onClick={() => {
            void navigator.clipboard?.writeText(d.address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : short(d.address, 10, 6)}
        </button>
        {d.env === "network" && (
          <Link className="ide-link" to={`/contract/${d.address}`}>
            Explorer
          </Link>
        )}
        <button type="button" className="ide-link" aria-label={`Remove ${d.address} from the list`} onClick={onRemove}>
          ×
        </button>
      </div>
      <p className="muted ide-deployed-name">
        {d.name}
        {d.pending ? " · waiting for a block" : ""}
      </p>
      {d.methods.map((m) => (
        <MethodForm key={m} method={m} hint={d.hints[m]} placeholders={placeholders} canRun={canRun} onRun={onRun} />
      ))}
    </div>
  );
}

function MethodForm({ method, hint, placeholders, canRun, onRun }: {
  method: string;
  hint?: MethodHint;
  placeholders: Record<string, string>;
  canRun: boolean;
  onRun: (method: string, args: string, read: boolean, attachSymbol: string, attachAmount: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(hint?.read ?? false);
  const [args, setArgs] = useState<string | null>(null);
  const [symbol, setSymbol] = useState(hint?.attach?.symbol ?? "XRGE");
  const [amount, setAmount] = useState(hint?.attach ? (hint.attach.symbol === "XRGE" ? formatXrge(hint.attach.amount).replace(/,/g, "") : hint.attach.amount) : "");
  const argsText = args ?? fillPlaceholders(hint?.args ?? "{}", placeholders);
  const unfilled = /\{\{\w+\}\}/.test(argsText);
  const amountBase = symbol.trim().toUpperCase() === "XRGE" ? parseXrge(amount) : /^\d+$/.test(amount.trim()) ? amount.trim() : null;
  const badAmount = amount.trim() !== "" && amountBase === null;

  return (
    <div className={`ide-method${open ? " open" : ""}`}>
      <button type="button" className="ide-method-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mono">{method}</span>
        <span className={`ide-kind ${read ? "read" : "write"}`}>{read ? "read" : "call"}</span>
        {hint?.attach && !read ? <span className="ide-kind pay">payable</span> : null}
      </button>
      {open && (
        <div className="ide-method-body">
          <label className="ide-field">
            <span>Arguments (JSON)</span>
            <textarea className="mono" rows={Math.min(6, Math.max(1, argsText.split("\n").length))} spellCheck={false} value={argsText} onChange={(e) => setArgs(e.target.value)} />
          </label>
          {unfilled && <p className="ide-hint warn">Fill in the {"{{…}}"} values first{placeholders.collection === undefined && /collection|token/.test(argsText) ? " — Local chain → Create demo NFT fills them" : ""}.</p>}
          {!read && (
            <div className="ide-pay">
              <label className="ide-field">
                <span>Pay</span>
                <input className="mono" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={badAmount} />
              </label>
              <label className="ide-field ide-symbol">
                <span>Token</span>
                <input className="mono" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
              </label>
            </div>
          )}
          {badAmount && <p className="ide-hint warn">{symbol.toUpperCase() === "XRGE" ? "XRGE amount with up to 9 decimals." : "Token amounts are whole base units."}</p>}
          {hint?.note && <p className="ide-hint">{hint.note}</p>}
          <div className="ide-row">
            <button
              type="button"
              className="button small ide-primary"
              disabled={!canRun || unfilled || badAmount}
              onClick={() => onRun(method, argsText, read, amountBase && !read ? symbol.trim().toUpperCase() : "", amountBase && !read ? amountBase : "")}
            >
              {read ? "Read" : "Call"}
            </button>
            <label className="ide-check">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> Read-only
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function Console({ log }: { log: LogEntry[] }) {
  if (!log.length) return <p className="muted ide-empty">Deploys and calls show up here with their return values, events and gas.</p>;
  return (
    <ol className="ide-log">
      {log.map((e) => (
        <li key={e.id} className={e.ok === null ? "pending" : e.ok ? "ok" : "fail"}>
          <div className="ide-log-head">
            <span className="ide-log-status" aria-label={e.ok === null ? "pending" : e.ok ? "succeeded" : "failed"} />
            <span className="ide-log-title">{e.title}</span>
            <span className={`ide-env ${e.env}`}>{e.env === "local" ? "Local" : "Network"}</span>
            <time className="muted">{e.at}</time>
          </div>
          {e.lines.length > 0 && (
            <dl>
              {e.lines.map((l, i) => (
                <div key={i}>
                  <dt>{l.label}</dt>
                  <dd className="mono">{l.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ol>
  );
}

function ChainPanel({ snap, accounts, account, labelOf, template, onDemoNft, tool }: {
  snap: Snapshot | null;
  accounts: LocalAccount[];
  account?: LocalAccount;
  labelOf: (addr: string) => string;
  template: Template;
  onDemoNft: () => void;
  tool: (title: string, run: (chain: LocalChain) => string | void) => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("10");
  const [nft, setNft] = useState("");
  if (!snap) return <p className="muted ide-empty">Starting the local chain…</p>;
  const targets: { label: string; value: string }[] = [
    ...accounts.filter((a) => a.address !== account?.address).map((a) => ({ label: a.label, value: a.publicKey })),
    ...snap.contracts.map((c) => ({ label: `Contract ${short(c.address, 6, 4)}`, value: c.address })),
  ];
  const target = to || targets[0]?.value || "";
  const myNfts = snap.nfts.filter((n) => n.ownerAddress === account?.address);
  const nftKey = nft || (myNfts[0] ? `${myNfts[0].collection}#${myNfts[0].token_id}` : "");
  const quanta = parseXrge(amount);

  return (
    <div className="ide-chain">
      <div className="ide-chain-tools">
        <p className="muted">
          Block {snap.height} · {new Date(snap.time * 1000).toLocaleString()} · acting as <strong>{account?.label}</strong>. No fees, nothing leaves your browser.
        </p>
        <div className="ide-row wrap">
          <span className="ide-tool-label">Clock</span>
          {[
            ["+1 hour", 3600],
            ["+1 day", 86400],
            ["+3 days", 3 * 86400],
          ].map(([l, s]) => (
            <button key={l} type="button" className="button ghost small" onClick={() => tool(`Advance time ${l}`, (c) => c.advanceTime(BigInt(s as number)))}>
              {l}
            </button>
          ))}
        </div>
        <div className="ide-row wrap">
          <span className="ide-tool-label">Send</span>
          <select aria-label="Recipient" value={target} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input className="mono ide-num" aria-label="XRGE amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button
            type="button"
            className="button ghost small"
            disabled={!account || !target || !quanta}
            onClick={() => account && quanta && tool(`Send ${amount} XRGE to ${labelOf(target)}`, (c) => c.transferXrge(account.publicKey, target, quanta))}
          >
            Send XRGE
          </button>
          <select aria-label="NFT to send" value={nftKey} onChange={(e) => setNft(e.target.value)} disabled={!myNfts.length}>
            {myNfts.length ? (
              myNfts.map((n) => (
                <option key={`${n.collection}#${n.token_id}`} value={`${n.collection}#${n.token_id}`}>
                  {n.name}
                </option>
              ))
            ) : (
              <option value="">No NFTs</option>
            )}
          </select>
          <button
            type="button"
            className="button ghost small"
            disabled={!account || !target || !nftKey}
            onClick={() => {
              if (!account) return;
              const i = nftKey.lastIndexOf("#");
              const col = nftKey.slice(0, i);
              const id = BigInt(nftKey.slice(i + 1));
              tool(`Send NFT ${col} #${id} to ${labelOf(target)}`, (c) => c.transferNft(account.publicKey, col, id, target));
            }}
          >
            Send NFT
          </button>
        </div>
        <div className="ide-row wrap">
          <span className="ide-tool-label">Create</span>
          <button type="button" className={`button small ${template.demo === "nft" ? "ide-primary" : "ghost"}`} disabled={!account} onClick={onDemoNft}>
            Demo NFT
          </button>
          <button
            type="button"
            className="button ghost small"
            disabled={!account}
            onClick={() =>
              account &&
              tool(`Create token`, (c) => {
                const sym = `TOK${snap.tokens.length + 1}`;
                c.createToken(account.publicKey, sym, "1000000");
                return `${sym}: 1,000,000 units to ${account.label}`;
              })
            }
          >
            Token
          </button>
          <button type="button" className="button ghost small" disabled={!account} onClick={() => account && tool(`Faucet`, (c) => { c.fund(account.address, (1000n * 1_000_000_000n).toString()); return `+1,000 XRGE to ${account.label}`; })}>
            +1,000 XRGE
          </button>
        </div>
      </div>
      <div className="ide-chain-tables">
        <Table title="XRGE" empty="No balances." head={["Holder", "XRGE"]} rows={snap.xrge.map((x) => [labelOf(x.address), formatXrge(x.quanta)])} />
        <Table title="NFTs" empty="No NFTs yet — Create → Demo NFT." head={["NFT", "Owner"]} rows={snap.nfts.map((n) => [n.name, labelOf(n.ownerAddress)])} />
        {snap.tokens.length > 0 && <Table title="Tokens" empty="" head={["Holder", "Amount"]} rows={snap.tokens.map((t) => [labelOf(t.owner), `${Number(t.amount).toLocaleString()} ${t.symbol}`])} />}
      </div>
    </div>
  );
}

function Table({ title, head, rows, empty }: { title: string; head: [string, string]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="ide-table">
      <h3>{title}</h3>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>{head[0]}</th>
              <th className="num">{head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r[0]}</td>
                <td className="num mono">{r[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </div>
  );
}
