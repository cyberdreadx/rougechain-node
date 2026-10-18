/**
 * /shield — shielded pool V2 (behind VITE_SHIELD_V2_ENABLED). Everything the page shows follows
 * core/shield-v2-wallet/UI_CONTRACT.md; the worker does every wallet operation (useShield.ts).
 *
 * Wording rules (spec §6, UI_CONTRACT limit 7): nothing here calls the pool's privacy audited,
 * proven or guaranteed, or a balance "verified by the network"; every bound is a block count,
 * with any duration only beside it, as an estimate from an observed rate.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Status } from "@rougechain/ui";
import { toDataURL } from "qrcode";
import { useSigner, useWallet } from "../wallet/WalletProvider";
import { CopyText, UnlockForm } from "../wallet/parts";
import { DEFAULT_NODES, MIN_NODES, loadNodes, originProblem, saveNodes, shieldV2Enabled, usableOrigins, type ConfiguredNode } from "./config";
import type { PaymentResult, ShieldViewModel } from "./client";
import { useShieldSession, type ShieldSession } from "./useShield";
import { fromQuanta, toQuanta } from "./units";
import type { WorkerFactory } from "./host";
import "./shield.css";

const MIN_FEE = "1";

function Main({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="app-main shield-main">
      <div className="container">{children}</div>
    </main>
  );
}

/** The statement required near the top (spec §6; owner decisions). */
function Statement() {
  const { t } = useTranslation("shield");
  return (
    <section className="notice warning shield-statement" aria-label={t("statement.label")}>
      <p>{t("statement.hidden")}</p>
      <p>{t("statement.public")}</p>
      <p>{t("statement.cap")}</p>
      <p>
        <strong>{t("statement.noAuditYet")}</strong>
      </p>
    </section>
  );
}

function Heading() {
  const { t } = useTranslation("shield");
  return (
    <div className="app-page-heading">
      <div>
        <div className="eyebrow">{t("eyebrow")}</div>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
      </div>
      <Status state="warning">{t("experimental")}</Status>
    </div>
  );
}

/** "N blocks — at the rate of the last D days about X days; an idle chain makes no blocks." Never a countdown. */
export function Blocks({ n, rate }: { n: number; rate: ShieldViewModel["rate"] }) {
  const { t } = useTranslation("shield");
  if (!rate || rate.blocks_per_day <= 0) return <>{t("blocks.only", { count: n })}</>;
  const days = n / rate.blocks_per_day;
  return <>{t("blocks.withRate", { count: n, estimate: days < 1 ? t("blocks.lessThanADay") : t("blocks.days", { count: Math.round(days) }), period: Math.max(1, Math.round(rate.days)) })}</>;
}

function useQr(address: string | null): string | null {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    // 1,974 characters. Upper case (which decodes to the same address, spec §5.3) lets the QR code
    // use its alphanumeric mode; error correction M then fits in a version-31-ish symbol — the
    // densest a phone camera reads reliably from a screen. H does not fit at all; Q makes it denser.
    toDataURL(address.toUpperCase(), { errorCorrectionLevel: "M", margin: 2, width: 420, color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => live && setQr(url))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [address]);
  return qr;
}

function AddressCard({ address, fingerprint }: { address: string; fingerprint: string }) {
  const { t } = useTranslation("shield");
  const qr = useQr(address);
  return (
    <section className="surface shield-card" aria-labelledby="shield-address">
      <h2 id="shield-address">{t("address.title")}</h2>
      <p className="form-hint">{t("address.body")}</p>
      {qr && <img className="shield-qr" src={qr} alt={t("address.qrAlt")} width={300} height={300} />}
      <CopyText value={address} label={t("address.copyLabel")} display={`${address.slice(0, 24)}…${address.slice(-12)}`} />
      <p className="shield-fingerprint">
        {t("address.fingerprint")} <code className="mono" data-testid="fingerprint">{fingerprint.match(/.{4}/g)?.join(" ")}</code>
      </p>
      <p className="form-hint">{t("address.fingerprintHint")}</p>
    </section>
  );
}

function StopNotice({ view, onTryAgain }: { view: ShieldViewModel; onTryAgain: () => void }) {
  const { t } = useTranslation("shield");
  const s = view.stop;
  if (s?.kind === "pool_inactive") return <p className="notice" role="status" data-testid="state-inactive">{t("stop.inactive")}</p>;
  if (s?.kind === "no_honest_listing_node")
    return (
      <div className="notice warning" role="alert" data-testid="state-no-honest">
        <p>{t("stop.noHonest", { nodes: view.nodes.filter((n) => n.banned).map((n) => n.origin).join(", ") })}</p>
        <Button variant="outline small" onClick={onTryAgain}>{t("stop.tryAgain")}</Button>
      </div>
    );
  if (s?.kind === "fault")
    return (
      <div className="notice warning" role="alert" data-testid="state-fault">
        <p>{t("stop.fault")}</p>
        <Button variant="outline small" onClick={onTryAgain}>{t("stop.tryAgain")}</Button>
      </div>
    );
  return null;
}

function SyncNotices({ view }: { view: ShieldViewModel }) {
  const { t } = useTranslation("shield");
  return (
    <>
      {view.waiting && (
        <p className="notice" role="status" data-testid="state-waiting">
          {t("sync.waiting", { nodes: view.waiting.missing.join(", ") || t("sync.everyNode"), round: view.waiting.waited, of: view.waiting.of })} {t("sync.waitingCost")}
        </p>
      )}
      {view.rechecking && <p className="notice" role="status">{t("sync.rechecking")}</p>}
      {view.nodes.filter((n) => n.outdated).map((n) => (
        <p key={n.origin} className="notice" role="status">{t("sync.outdated", { node: n.origin })}</p>
      ))}
      {view.nodes.filter((n) => n.inactive && !n.banned && !view.stop).map((n) => (
        <p key={n.origin} className="notice" role="status">{t("sync.nodeInactive", { node: n.origin })}</p>
      ))}
      {view.nodes.filter((n) => n.dissents).map((n) => (
        <p key={n.origin} className="form-hint">{t("sync.disagrees", { node: n.origin })}</p>
      ))}
    </>
  );
}

function Balances({ view }: { view: ShieldViewModel }) {
  const { t } = useTranslation("shield");
  const b = view.balances;
  const row = (label: string, q: string, hint: string, id: string) => (
    <div className="shield-balance" data-testid={`balance-${id}`}>
      <span>{label}</span>
      <strong className="mono">{fromQuanta(q)} XRGE</strong>
      <small>{hint}</small>
    </div>
  );
  return (
    <section className="surface shield-card" aria-labelledby="shield-balances">
      <h2 id="shield-balances">{t("balances.title")}</h2>
      <div className="shield-balances">
        {row(t("balances.confirmed"), b.confirmed, view.confirmed_height === null ? t("balances.confirmedNone") : t("balances.confirmedAt", { height: view.confirmed_height, quorum: view.quorum, nodes: view.nodes.length }), "confirmed")}
        {row(t("balances.unverified"), b.unverified, t("balances.unverifiedHint"), "unverified")}
        {row(t("balances.locked"), b.locked, t("balances.lockedHint"), "locked")}
        {row(t("balances.spendable"), b.spendable, t("balances.spendableHint"), "spendable")}
      </div>
      {b.expected_change !== "0" && <p className="form-hint">{t("balances.expectedChange", { amount: fromQuanta(b.expected_change) })}</p>}
      {b.below_minimum.count > 0 && <p className="form-hint">{t("balances.belowMinimum", { count: b.below_minimum.count, amount: fromQuanta(b.below_minimum.total) })}</p>}
      {b.over_capacity.count > 0 && <p className="form-hint">{t("balances.overCapacity", { count: b.over_capacity.count })}</p>}
      <p className="form-hint">{t("balances.trust")}</p>
    </section>
  );
}

function Embargo({ view, onConfirm }: { view: ShieldViewModel; onConfirm: () => Promise<boolean> }) {
  const { t } = useTranslation("shield");
  const [dialog, setDialog] = useState(false);
  const [ticked, setTicked] = useState(false);
  const restored = view.origin !== "generated";
  const embargo = view.spend.reason === "embargo";
  if (!restored && !embargo) return null;
  // The statement may be offered only before the first confirmed state check of this state.
  const canStillState = view.awaiting_base && !view.sole_copy_asserted;
  return (
    <section className="surface shield-card" aria-labelledby="shield-restore" data-testid="restore-panel">
      <h2 id="shield-restore">{t("restore.title")}</h2>
      <p className="notice warning">{t("restore.inFlight")}</p>
      <p>{t("restore.devices")}</p>
      {embargo && (
        <p data-testid="embargo">
          {view.spend.embargo_blocks_left === null ? (
            t("restore.embargoUnknown", { min: view.spend.restore_embargo_blocks, max: view.spend.restore_embargo_blocks + view.spend.restore_lag_bound_blocks })
          ) : (
            <>
              {t("restore.embargoLeft", { until: view.spend.embargo_until })} <Blocks n={view.spend.embargo_blocks_left} rate={view.rate} />
            </>
          )}
        </p>
      )}
      {embargo && <p className="form-hint">{t("restore.shieldStillWorks")}</p>}
      {canStillState && !dialog && (
        <button type="button" className="link-button shield-quiet-link" onClick={() => setDialog(true)}>
          {t("restore.statementLink")}
        </button>
      )}
      {canStillState && dialog && (
        <div className="shield-dialog" role="dialog" aria-modal="false" aria-labelledby="sole-copy-title">
          <h3 id="sole-copy-title">{t("restore.dialogTitle")}</h3>
          <p className="notice warning" data-testid="sole-copy-sentence">{t("restore.sentence")}</p>
          <p className="form-hint">{t("restore.lostDevice")}</p>
          <label className="check-row">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
            <span>{t("restore.tick")}</span>
          </label>
          <div className="actions">
            {/* the default action is "wait" (obligation 1) */}
            <Button autoFocus onClick={() => (setDialog(false), setTicked(false))}>{t("restore.wait")}</Button>
            <Button variant="outline" disabled={!ticked} onClick={() => void onConfirm().then(() => setDialog(false))}>
              {t("restore.confirm")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function resultText(t: (k: string, o?: Record<string, unknown>) => string, r: PaymentResult | null): string | null {
  if (!r) return null;
  switch (r.status) {
    case "submitted":
      return t(`result.submitted.${r.submit}`);
    case "needs_merge":
      return t("result.needsMerge", { count: r.merges, fee: MIN_FEE });
    case "insufficient_funds":
      return t("result.insufficient", { have: fromQuanta(r.have), need: fromQuanta(r.need) });
    case "not_offered":
      return t("result.notOffered");
    case "not_written":
      return t("result.notWritten");
    case "refused":
      return t("result.refused", { code: r.code });
  }
}

function PaymentForms({ view, session, canSign, onShield }: { view: ShieldViewModel; session: ShieldSession; canSign: boolean; onShield: (vIn: string, fee: string) => Promise<PaymentResult | null> }) {
  const { t } = useTranslation("shield");
  const [tab, setTab] = useState<"shield" | "transfer" | "unshield">("shield");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState(MIN_FEE);
  const [to, setTo] = useState("");
  const [toFp, setToFp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const proving = session.phase === "proving";
  const readOnly = view.nodes.length < MIN_NODES;

  useEffect(() => {
    setToFp(null);
    if (tab === "transfer" && to.startsWith("rshield1")) void session.parseAddress(to.trim()).then((p) => setToFp(p?.fingerprint ?? null));
  }, [to, tab, session]);

  const amountQ = toQuanta(amount);
  const feeQ = toQuanta(fee);
  const noteQ = amountQ && feeQ && BigInt(amountQ) > BigInt(feeQ) ? (BigInt(amountQ) - BigInt(feeQ)).toString() : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!amountQ || !feeQ) return setError(t("form.badAmount"));
    if (BigInt(feeQ) < 1_000_000_000n) return setError(t("form.feeMin"));
    let r: PaymentResult | null = null;
    if (tab === "shield") {
      if (!noteQ) return setError(t("form.shieldTooSmall"));
      r = await onShield(amountQ, feeQ);
    } else if (tab === "transfer") {
      if (!toFp) return setError(t("form.badShieldedAddress"));
      r = await session.transfer(to.trim(), amountQ, feeQ);
    } else {
      if (!/^rouge1[02-9ac-hj-np-z]{6,}$/.test(to.trim())) return setError(t("form.badRougeAddress"));
      r = await session.unshield(to.trim(), amountQ, feeQ);
    }
    setMessage(resultText(t, r));
    if (r?.status === "submitted") setAmount("");
  };

  const spendBlocked = tab !== "shield" && !view.offer;
  const shieldBlocked = tab === "shield" && (!canSign || !view.shield.available);
  return (
    <section className="surface shield-card" aria-labelledby="shield-pay">
      <h2 id="shield-pay">{t("form.title")}</h2>
      <div className="mode-switch" role="tablist">
        {(["shield", "transfer", "unshield"] as const).map((k) => (
          <Button key={k} role="tab" aria-selected={tab === k} variant={tab === k ? "small" : "outline small"} onClick={() => (setTab(k), setTo(""), setMessage(null), setError(null))}>
            {t(`form.tabs.${k}`)}
          </Button>
        ))}
      </div>
      <p className="form-hint">{t(`form.about.${tab}`)}</p>
      {readOnly ? (
        <p className="notice">{t("nodes.readOnly", { count: MIN_NODES })}</p>
      ) : (
        <form className="wallet-form" onSubmit={(e) => void submit(e)}>
          {tab !== "shield" && (
            <label className="field">
              {tab === "transfer" ? t("form.toShielded") : t("form.toRouge")}
              <input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder={tab === "transfer" ? "rshield1…" : "rouge1…"} autoComplete="off" spellCheck={false} />
            </label>
          )}
          {tab === "transfer" && toFp && (
            <p className="form-hint" data-testid="recipient-fingerprint">
              {t("form.compareFingerprint")} <code className="mono">{toFp.match(/.{4}/g)?.join(" ")}</code>
            </p>
          )}
          <label className="field">
            {tab === "shield" ? t("form.amountShield") : t("form.amount")}
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          </label>
          <label className="field">
            {t("form.fee")}
            <input className="input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
          </label>
          {tab === "shield" && noteQ && <p className="form-hint" data-testid="shield-note">{t("form.shieldNote", { note: fromQuanta(noteQ), fee: fromQuanta(feeQ!) })}</p>}
          {tab === "shield" && view.shield.pool_total && <p className="form-hint">{t("form.poolCap", { total: fromQuanta(view.shield.pool_total), cap: fromQuanta(view.shield.pool_cap) })}</p>}
          {tab === "unshield" && amountQ && feeQ && <p className="form-hint">{t("form.unshieldTotal", { total: fromQuanta(BigInt(amountQ) + BigInt(feeQ)) })}</p>}
          {tab !== "shield" && view.spend.usable_window_blocks !== null && view.offer && (
            <p className="form-hint">{t("form.expiry", { count: view.spend.default_expiry_blocks, window: view.spend.usable_window_blocks })}</p>
          )}
          {spendBlocked && <p className="notice" data-testid="spend-blocked">{t(`spendReason.${view.spend.reason ?? "notAtTip"}`)}</p>}
          {tab === "shield" && !canSign && <p className="notice">{t("form.noSigner")}</p>}
          {tab === "shield" && canSign && !view.shield.available && <p className="notice">{t("form.shieldWaiting")}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" disabled={proving || spendBlocked || shieldBlocked}>
            {proving ? t("form.proving") : t(`form.submit.${tab}`)}
          </Button>
          {proving && <p className="form-hint" role="status">{t("form.provingHint")}</p>}
          {message && <p className="form-hint" role="status" data-testid="payment-result">{message}</p>}
        </form>
      )}
    </section>
  );
}

function Pending({ view, session }: { view: ShieldViewModel; session: ShieldSession }) {
  const { t } = useTranslation("shield");
  if (!view.pending.length && !view.history.length) return null;
  return (
    <section className="surface shield-card" aria-labelledby="shield-pending">
      <h2 id="shield-pending">{t("pending.title")}</h2>
      <p className="form-hint">{t("pending.walletOnly")}</p>
      <ul className="shield-list">
        {view.pending.map((p) => (
          <li key={p.id} data-testid="pending-item">
            <strong>{t(`kind.${p.kind}`)}</strong> {p.amount && <span className="mono">{fromQuanta(p.amount)} XRGE</span>} {p.to && p.to !== "self" && <code className="mono">{p.to.length > 20 ? `${p.to.slice(0, 14)}…` : p.to}</code>}
            <span className="shield-tag">{t(`pending.status.${p.status}`)}</span>
            <small>
              {p.blocks_left === null ? t("pending.expiresAt", { height: p.expiry_height }) : <>{t("pending.expiresIn", { height: p.expiry_height })} <Blocks n={p.blocks_left} rate={view.rate} /></>}
            </small>
            {p.rejected_hint && <small>{t("pending.rejected", { height: p.expiry_height })}</small>}
            {p.submit && p.submit !== "accepted" && (
              <span>
                <small>{t(`pending.submit.${p.submit}`)}</small>{" "}
                <Button variant="outline small" onClick={() => void session.resubmit(p.id)}>{t("pending.submitAgain")}</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {view.history.filter((h) => h.outcome !== "pending").length > 0 && (
        <>
          <h3>{t("history.title")}</h3>
          <ul className="shield-list">
            {view.history.filter((h) => h.outcome !== "pending").map((h) => (
              <li key={h.id} data-testid="history-item">
                <strong>{t(`kind.${h.kind}`)}</strong> <span className="mono">{fromQuanta(h.amount)} XRGE</span> <span className="shield-tag">{t(`history.outcome.${h.outcome}`)}</span>
                {(h.outcome === "superseded" || h.outcome === "expired") && <small>{t(`history.retry.${h.outcome}`)}</small>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function NodesPanel({ network, nodes, view, onChange }: { network: string; nodes: ConfiguredNode[]; view: ShieldViewModel | null; onChange: (n: ConfiguredNode[] | null) => void }) {
  const { t } = useTranslation("shield");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const usable = usableOrigins(nodes);
  const status = (origin: string) => view?.nodes.find((n) => n.origin === new URL(origin).origin);
  return (
    <section className="surface shield-card" aria-labelledby="shield-nodes" data-testid="nodes-panel">
      <h2 id="shield-nodes">{t("nodes.title")}</h2>
      <p>{t("nodes.body")}</p>
      {usable.length < MIN_NODES && <p className="notice warning" data-testid="need-three">{t("nodes.needThree", { count: MIN_NODES, have: usable.length })}</p>}
      <ul className="shield-list">
        {nodes.map((n, i) => {
          const s = n.origin ? status(n.origin) : undefined;
          return (
            <li key={i}>
              <code className="mono">{n.origin ?? t("nodes.placeholder")}</code> <small>{t("nodes.operator", { operator: n.operator })}</small>
              {s?.listing && <span className="shield-tag">{t("nodes.listing")}</span>}
              {s?.banned && <span className="shield-tag warn">{t("nodes.banned")}</span>}
              {s?.outdated && <span className="shield-tag">{t("nodes.outdated")}</span>}
            </li>
          );
        })}
      </ul>
      <p className="form-hint">{t("nodes.majority")}</p>
      {!editing ? (
        <Button variant="outline small" onClick={() => (setDraft(nodes.filter((n) => n.origin).map((n) => `${n.origin} ${n.operator}`).join("\n")), setEditing(true))}>
          {t("nodes.edit")}
        </Button>
      ) : (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            const list: ConfiguredNode[] = [];
            for (const line of draft.split("\n").map((l) => l.trim()).filter(Boolean)) {
              const [origin, ...op] = line.split(/\s+/);
              const p = originProblem(origin);
              if (p) return setError(t(`nodes.problem.${p}`, { origin }));
              if (!op.length) return setError(t("nodes.problem.operator", { origin }));
              list.push({ origin, operator: op.join(" ") });
            }
            setError(null);
            setEditing(false);
            onChange(list);
          }}
        >
          <label className="field">
            {t("nodes.editLabel")}
            <textarea className="input mono" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="nodes-input" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="actions">
            <Button type="submit">{t("nodes.save")}</Button>
            <Button type="button" variant="outline" onClick={() => (setEditing(false), onChange(null))}>{t("nodes.reset", { network })}</Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Why there is no shielded address for this wallet, or null when there is one. */
function useGate(): { kind: "none" | "locked" | "provider" | "rawKey" | "ok"; mnemonic: string | null } {
  const { status, wallet, isExtension } = useWallet();
  if (status === "none") return { kind: "none", mnemonic: null };
  if (status === "locked" || !wallet) return { kind: "locked", mnemonic: null };
  if (isExtension) return { kind: "provider", mnemonic: null };
  if (!wallet.mnemonic) return { kind: "rawKey", mnemonic: null };
  return { kind: "ok", mnemonic: wallet.mnemonic };
}

export default function ShieldPage({ workerFactory }: { workerFactory?: WorkerFactory } = {}) {
  const { t } = useTranslation("shield");
  const { network } = useWallet();
  const signer = useSigner();
  const gate = useGate();
  const [nodes, setNodes] = useState<ConfiguredNode[]>(() => loadNodes(network));
  useEffect(() => setNodes(loadNodes(network)), [network]);
  const origins = useMemo(() => usableOrigins(nodes), [nodes]);
  const enabled = shieldV2Enabled() && gate.kind === "ok";
  const session = useShieldSession({ mnemonic: gate.mnemonic, network, origins, enabled, factory: workerFactory });
  const view = session.view;

  if (!shieldV2Enabled()) return null;
  const changeNodes = (n: ConfiguredNode[] | null) => {
    saveNodes(network, n);
    setNodes(n ?? DEFAULT_NODES[network]);
  };

  let body: ReactNode;
  if (gate.kind === "none") body = <p className="notice">{t("gate.none")}</p>;
  else if (gate.kind === "locked")
    body = (
      <section className="surface shield-card">
        <p>{t("gate.locked")}</p>
        <UnlockForm />
      </section>
    );
  else if (gate.kind === "provider") body = <p className="notice" data-testid="gate-provider">{t("gate.provider")}</p>;
  else if (gate.kind === "rawKey") body = <p className="notice" data-testid="gate-raw">{t("gate.rawKey")}</p>;
  else if (session.phase === "other_tab") body = <p className="notice" data-testid="other-tab">{t("otherTab")}</p>;
  else if (session.phase === "starting" && !view) body = <p className="form-hint" role="status">{t("loading")}</p>;
  else
    body = (
      <>
        {session.error && <p className="form-error" role="alert">{t("error", { message: session.error })}</p>}
        {session.address && session.fingerprint && <AddressCard address={session.address} fingerprint={session.fingerprint} />}
        {view && (
          <>
            <StopNotice view={view} onTryAgain={() => void session.tryAgain()} />
            <SyncNotices view={view} />
            {view.stop?.kind !== "pool_inactive" && view.nodes.length >= MIN_NODES && <Balances view={view} />}
            <Embargo view={view} onConfirm={session.confirmSoleCopy} />
            <PaymentForms
              view={view}
              session={session}
              canSign={!!signer?.signBytes}
              onShield={(vIn, fee) => session.shield(vIn, fee, signer!.publicKey, (hex) => signer!.signBytes!(hex))}
            />
            <Pending view={view} session={session} />
          </>
        )}
      </>
    );

  return (
    <Main>
      <Heading />
      <Statement />
      {body}
      <NodesPanel network={network} nodes={nodes} view={view} onChange={changeNodes} />
    </Main>
  );
}
