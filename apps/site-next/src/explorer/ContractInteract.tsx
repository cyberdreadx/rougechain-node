import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  executeContract,
  maxTotalXrge,
  parseAttachInput,
  queryContract,
  receiptError,
  suggestGasLimit,
  waitForTxReceipt,
  type ContractAttach,
  type ContractEvent,
} from "@rougechain/core/contracts";
import { getActiveNetwork, siteUrlFor } from "@rougechain/core/network";
import { exampleArgs, identifyContract, type KnownContract, type KnownMethod } from "../contracts/known";
import { useOptionalWallet } from "../wallet/WalletProvider";
import { useRougeAddress } from "../wallet/hooks";
import { useChain } from "./chain";
import "./contract-interact.css";

type Mode = "read" | "write";

/** Whether the connected wallet can sign here, and if not, why. */
type Signer =
  | { ok: true; publicKey: string }
  | { ok: false; reason: "no_provider" | "none" | "locked" | "needs_password" | "other_network" };

function useSigner(): Signer {
  const w = useOptionalWallet();
  const { network } = useChain();
  if (!w) return { ok: false, reason: "no_provider" };
  if (w.status === "none" || !w.publicKey) return { ok: false, reason: "none" };
  if (w.status === "locked") return { ok: false, reason: "locked" };
  if (w.needsPassword) return { ok: false, reason: "needs_password" };
  if (w.network !== network) return { ok: false, reason: "other_network" };
  return { ok: true, publicKey: w.publicKey };
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

function parseArgs(text: string): unknown {
  const t = text.trim();
  return t ? JSON.parse(t) : {};
}

export function ContractInteract({ addr, codeHash }: { addr: string; codeHash: string }) {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  const known = identifyContract(codeHash);
  const [mode, setMode] = useState<Mode>("read");
  const signer = useSigner();
  const w = useOptionalWallet();
  const { full: me } = useRougeAddress(w?.publicKey ?? null);

  // Reads and writes go through the core client, which follows the same saved network as the
  // explorer. If they ever disagree (a pinned deploy), refuse rather than call the wrong chain.
  const coreNetwork = safeActiveNetwork();
  if (coreNetwork !== network) {
    return (
      <p className="interact-note warn" role="status">
        {t("interact.networkMismatch")}
      </p>
    );
  }

  const methods = known
    ? Object.entries(known.methods).filter(([, m]) => (mode === "read" ? m.read : !m.read))
    : [];

  return (
    <div className="interact">
      <div className="interact-tabs" role="tablist" aria-label={t("interact.tabs")}>
        {(["read", "write"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            id={`interact-tab-${m}`}
            aria-selected={mode === m}
            aria-controls="interact-panel"
            className={`interact-tab${mode === m ? " active" : ""}`}
            onClick={() => setMode(m)}
          >
            {t(m === "read" ? "interact.readTab" : "interact.writeTab")}
          </button>
        ))}
      </div>
      <div className="interact-panel" role="tabpanel" id="interact-panel" aria-labelledby={`interact-tab-${mode}`}>
        <p className="interact-note">
          {mode === "read" ? t("interact.readIntro") : t("interact.writeIntro", { network: networkName(network) })}
        </p>
        {mode === "write" && <SignerNote signer={signer} addr={addr} />}
        {known ? (
          <KnownHeader known={known} />
        ) : (
          <p className="interact-note">{t("interact.unknown")}</p>
        )}
        {methods.map(([name, m]) => (
          <MethodForm
            key={`${mode}-${name}`}
            addr={addr}
            mode={mode}
            name={name}
            method={m}
            me={me}
            signer={signer}
          />
        ))}
        {known && methods.length === 0 && (
          <p className="interact-note">{mode === "read" ? t("interact.noReads") : t("interact.noWrites")}</p>
        )}
        <details className="interact-custom" open={!known}>
          <summary>{t("interact.customTitle")}</summary>
          <MethodForm key={`${mode}-custom`} addr={addr} mode={mode} name="" method={null} me={me} signer={signer} />
        </details>
      </div>
    </div>
  );
}

function safeActiveNetwork(): string {
  try {
    return getActiveNetwork();
  } catch {
    return "mainnet";
  }
}

function networkName(n: string) {
  return n === "mainnet" ? "Mainnet" : "Testnet";
}

function KnownHeader({ known }: { known: KnownContract }) {
  const { t } = useTranslation("explorer");
  return (
    <div className="interact-known">
      <span className="pill ok">{t("interact.matched")}</span>
      <div>
        <strong>{known.name}</strong>
        <span className="muted"> · {known.summary}</span>
        <div className="muted small">
          {t("interact.matchedBody")} <code className="mono">{known.dir}</code>
        </div>
      </div>
    </div>
  );
}

function SignerNote({ signer, addr }: { signer: Signer; addr: string }) {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  if (signer.ok) return null;
  if (signer.reason === "no_provider") {
    const href = `${siteUrlFor(network === "mainnet" ? "mainnet" : "testnet")}/contract/${addr}`;
    return (
      <p className="interact-note warn">
        {t("interact.signer.no_provider")}{" "}
        <a href={href}>{t("interact.openOnSite")}</a>
      </p>
    );
  }
  return (
    <p className="interact-note warn">
      {t(`interact.signer.${signer.reason}`)}{" "}
      {signer.reason !== "other_network" && <Link to="/wallet">{t("interact.goToWallet")}</Link>}
    </p>
  );
}

type Preview = {
  ok: boolean;
  returnData?: unknown;
  events: ContractEvent[];
  gasUsed: number;
  error?: string | null;
};

type WriteState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "ready"; args: unknown; attach: ContractAttach | null; gasLimit: number; preview: Preview }
  | { step: "signing" }
  | { step: "waiting"; txId: string }
  | { step: "done"; txId: string; height: number | null; failed: string | null }
  | { step: "sent"; txId: string };

function MethodForm({
  addr,
  mode,
  name,
  method,
  me,
  signer,
}: {
  addr: string;
  mode: Mode;
  name: string;
  method: KnownMethod | null;
  me: string | null;
  signer: Signer;
}) {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  const queryClient = useQueryClient();
  const custom = method === null;
  const [methodName, setMethodName] = useState(name);
  const [argsText, setArgsText] = useState(method ? exampleArgs(method, me) : "{}");
  const [paySymbol, setPaySymbol] = useState(method?.attach?.symbol ?? "XRGE");
  const [payAmount, setPayAmount] = useState(method?.attach?.amount ?? "");
  const [error, setError] = useState<string | null>(null);
  const [readResult, setReadResult] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [write, setWrite] = useState<WriteState>({ step: "idle" });
  const showPay = mode === "write" && (custom || !!method?.attach);
  const id = `m-${mode}-${name || "custom"}`;

  function inputs(): { method: string; args: unknown; attach: ContractAttach | null } | null {
    setError(null);
    const m = methodName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(m)) {
      setError(t("interact.errors.method"));
      return null;
    }
    let args: unknown;
    try {
      args = parseArgs(argsText);
    } catch {
      setError(t("interact.errors.json"));
      return null;
    }
    let attach: ContractAttach | null = null;
    if (showPay && payAmount.trim()) {
      try {
        attach = parseAttachInput(paySymbol, payAmount);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    }
    return { method: m, args, attach };
  }

  async function onRead(e: FormEvent) {
    e.preventDefault();
    const v = inputs();
    if (!v) return;
    setReading(true);
    setReadResult(null);
    try {
      const q = await queryContract(addr, v.method, v.args, signer.ok ? signer.publicKey : undefined);
      setReadResult({ ok: q.success, returnData: q.returnData, events: q.events, gasUsed: q.gasUsed, error: q.error });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  async function onCheck(e: FormEvent) {
    e.preventDefault();
    if (!signer.ok) return;
    const v = inputs();
    if (!v) return;
    setWrite({ step: "checking" });
    try {
      const q = await queryContract(addr, v.method, v.args, signer.publicKey, v.attach);
      const preview: Preview = { ok: q.success, returnData: q.returnData, events: q.events, gasUsed: q.gasUsed, error: q.error };
      if (!q.success) {
        setWrite({ step: "idle" });
        setReadResult(preview);
        return;
      }
      setReadResult(null);
      setWrite({ step: "ready", args: v.args, attach: v.attach, gasLimit: suggestGasLimit(q.gasUsed), preview });
    } catch (err) {
      setWrite({ step: "idle" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSend() {
    if (write.step !== "ready") return;
    const { args, attach, gasLimit } = write;
    setWrite({ step: "signing" });
    try {
      const r = await executeContract(addr, methodName.trim(), args, gasLimit, attach);
      if (!r.success || !r.txId) {
        setWrite({ step: "idle" });
        setError(r.error ?? t("interact.errors.refused"));
        return;
      }
      setWrite({ step: "waiting", txId: r.txId });
      const receipt = await waitForTxReceipt(r.txId);
      if (!receipt) {
        setWrite({ step: "sent", txId: r.txId });
        return;
      }
      const height = (receipt.block_height ?? (receipt as { blockHeight?: number }).blockHeight ?? null) as number | null;
      setWrite({ step: "done", txId: r.txId, height, failed: receiptError(receipt.status) });
      void queryClient.invalidateQueries({ queryKey: ["explorer", network] });
    } catch (err) {
      setWrite({ step: "idle" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = reading || write.step === "checking" || write.step === "signing" || write.step === "waiting";
  const locked = write.step === "ready" || busy;

  return (
    <form className="interact-method" onSubmit={mode === "read" ? onRead : onCheck} aria-labelledby={`${id}-name`}>
      <div className="interact-method-head">
        {custom ? (
          <label className="field interact-grow">
            {t("interact.method")}
            <input
              className="input mono"
              value={methodName}
              onChange={(e) => setMethodName(e.target.value)}
              placeholder="method_name"
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
            />
          </label>
        ) : (
          <h3 id={`${id}-name`} className="mono">
            {name}
          </h3>
        )}
        {!custom && <span className="pill">{mode === "read" ? t("interact.free") : t("interact.signed")}</span>}
      </div>
      {method?.about && <p className="interact-about">{method.about}</p>}
      {method?.warning && <p className="interact-note warn">{method.warning}</p>}
      <label className="field">
        {t("interact.args")}
        <textarea
          className="input mono interact-args"
          rows={Math.min(6, Math.max(1, argsText.split("\n").length))}
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          spellCheck={false}
          disabled={locked}
        />
      </label>
      {showPay && (
        <div className="interact-pay">
          <label className="field">
            {t("interact.paySymbol")}
            <input
              className="input mono"
              value={paySymbol}
              onChange={(e) => setPaySymbol(e.target.value)}
              disabled={locked || !custom}
              autoComplete="off"
            />
          </label>
          <label className="field interact-grow">
            {paySymbol.trim().toUpperCase() === "XRGE" ? t("interact.payAmountXrge") : t("interact.payAmountRaw")}
            <input
              className="input mono"
              inputMode="decimal"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder={custom ? t("interact.payOptional") : undefined}
              disabled={locked}
              autoComplete="off"
            />
          </label>
        </div>
      )}
      {error && (
        <p className="interact-error" role="alert">
          {error}
        </p>
      )}

      {mode === "read" ? (
        <div className="actions">
          <button type="submit" className="button outline small" disabled={reading}>
            {reading ? t("interact.querying") : t("interact.query")}
          </button>
        </div>
      ) : write.step === "ready" ? (
        <div className={`interact-confirm${network === "mainnet" ? " mainnet" : ""}`} role="alertdialog" aria-label={t("interact.confirmLabel")}>
          <PreviewBlock preview={write.preview} />
          <dl className="interact-cost">
            <div>
              <dt>{t("interact.network")}</dt>
              <dd>{networkName(network)}</dd>
            </div>
            <div>
              <dt>{t("interact.gasLimit")}</dt>
              <dd className="mono">{write.gasLimit.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("interact.maxCost")}</dt>
              <dd className="mono">{maxTotalXrge(write.gasLimit, write.attach)} XRGE</dd>
            </div>
          </dl>
          <p className="interact-note">
            {network === "mainnet" ? t("interact.confirmMainnet") : t("interact.confirmTestnet")}
          </p>
          <div className="actions">
            <button type="button" className="button small" onClick={() => void onSend()}>
              {t("interact.sign")}
            </button>
            <button type="button" className="button ghost small" onClick={() => setWrite({ step: "idle" })}>
              {t("interact.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="submit" className="button outline small" disabled={!signer.ok || busy}>
            {write.step === "checking"
              ? t("interact.checking")
              : write.step === "signing"
                ? t("interact.signing")
                : write.step === "waiting"
                  ? t("interact.waiting")
                  : t("interact.check")}
          </button>
        </div>
      )}

      {readResult && (
        <div className="interact-result" role="status">
          {mode === "write" && !readResult.ok && <p className="interact-error">{t("interact.wouldFail")}</p>}
          <PreviewBlock preview={readResult} />
        </div>
      )}
      {(write.step === "waiting" || write.step === "sent" || write.step === "done") && (
        <div className="interact-result" role="status">
          <p>
            {write.step === "waiting"
              ? t("interact.submitted")
              : write.step === "sent"
                ? t("interact.notYetIncluded")
                : write.failed
                  ? t("interact.failedInBlock", { reason: write.failed })
                  : t("interact.included", { height: write.height ?? "?" })}{" "}
            <Link className="mono address-link" to={`/tx/${write.txId}`}>
              {write.txId.slice(0, 10)}…{write.txId.slice(-6)}
            </Link>
          </p>
        </div>
      )}
    </form>
  );
}

function PreviewBlock({ preview }: { preview: Preview }) {
  const { t } = useTranslation("explorer");
  return (
    <div className="interact-preview">
      {preview.error && <p className="interact-error">{preview.error}</p>}
      {preview.returnData !== undefined && preview.returnData !== null && (
        <>
          <div className="interact-label">{t("interact.returned")}</div>
          <pre className="mono">{pretty(preview.returnData)}</pre>
        </>
      )}
      {preview.events.map((ev, i) => (
        <div key={i}>
          <div className="interact-label">
            {t("interact.event")} <span className="pill">{ev.topic || "—"}</span>
          </div>
          <pre className="mono">{pretty(ev.data)}</pre>
        </div>
      ))}
      <div className="interact-label muted">
        {t("interact.gasUsed")} <span className="mono">{preview.gasUsed.toLocaleString()}</span>
      </div>
    </div>
  );
}
