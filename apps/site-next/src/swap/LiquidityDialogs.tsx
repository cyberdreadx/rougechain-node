/**
 * Add / remove liquidity, collect fees and create pool — apps/web Pools.tsx flows. Each dialog
 * shows what will be signed (the review) next to its sign button; the write goes through core's
 * secure-api only (see ./api.ts).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Button, Dialog } from "@rougechain/ui";
import { rawToHuman } from "@rougechain/core/token-decimals";
import { toast } from "../wallet/toast";
import {
  submitAddLiquidity,
  submitCollectFees,
  submitCreatePool,
  submitRemoveLiquidity,
  canCollect,
  type LpEarnings,
  type Pool,
  type SigningWallet,
} from "./api";
import { lpForDeposit, makePoolId, pairedAmount, poolShare, removeEstimate } from "./amm";
import { fmtAmount, fmtLp, humanToInput, parseLpAmount, parseTokenAmount, rawToInput } from "./amounts";
import { ErrorLine, SignNote } from "./parts";
import { S } from "./strings";

interface Signing {
  wallet: SigningWallet;
  kind: "local" | "extension";
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function Review({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="review-list">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function AmountField({
  id,
  label,
  symbol,
  value,
  balance,
  onChange,
  error,
}: {
  id: string;
  label: string;
  symbol: string;
  value: string;
  balance?: number;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="field">
      <span className="field-row">
        <label htmlFor={id}>{label}</label>
        {balance !== undefined && (
          <button type="button" className="inline-link" onClick={() => onChange(rawToInput(balance, symbol))}>
            {S.swap.max} {fmtAmount(balance, symbol)}
          </button>
        )}
      </span>
      <input
        id={id}
        className="input mono"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={value}
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value.replace(",", "."))}
      />
      {error && <span className="form-hint error">{error}</span>}
    </div>
  );
}

function check(input: string, symbol: string, balance: number | undefined) {
  if (!input.trim()) return { raw: null as number | null, error: "" };
  const p = parseTokenAmount(input, symbol);
  if (!p.ok) return { raw: null, error: p.error };
  if (balance !== undefined && p.raw > balance) return { raw: p.raw, error: S.liquidity.exceeds(symbol) };
  return { raw: p.raw, error: "" };
}

const pairName = (p: Pick<Pool, "token_a" | "token_b">) => `${p.token_a}/${p.token_b}`;

export function AddLiquidityDialog({
  pool,
  signing,
  balances,
  onClose,
  onDone,
}: {
  pool: Pool | null;
  signing: Signing;
  balances: Record<string, number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const close = () => {
    setA("");
    setB("");
    submit.setError("");
    onClose();
  };
  const submit = useSubmit(() => {
    toast.success(S.toasts.added, { description: S.common.submittedNextBlock });
    close();
    onDone();
  });
  if (!pool) return null;
  const seeded = pool.reserve_a > 0 && pool.reserve_b > 0;
  const balA = balances[pool.token_a] ?? 0;
  const balB = balances[pool.token_b] ?? 0;
  const ca = check(a, pool.token_a, balA);
  const cb = check(b, pool.token_b, balB);
  // Keep the pool's ratio: typing one side fills the other (apps/web calculateQuote).
  const onA = (v: string) => {
    setA(v);
    if (!seeded) return;
    const p = parseTokenAmount(v, pool.token_a);
    setB(p.ok ? humanToInput(pairedAmount(pool, rawToHuman(p.raw, pool.token_a), true), pool.token_b) : "");
  };
  const onB = (v: string) => {
    setB(v);
    if (!seeded) return;
    const p = parseTokenAmount(v, pool.token_b);
    setA(p.ok ? humanToInput(pairedAmount(pool, rawToHuman(p.raw, pool.token_b), false), pool.token_a) : "");
  };
  const ready = ca.raw !== null && cb.raw !== null && !ca.error && !cb.error;
  const lp = ready ? lpForDeposit(ca.raw!, cb.raw!, pool) : 0;
  return (
    <Dialog open onClose={() => !submit.busy && close()} title={S.liquidity.addTitle(pairName(pool))}>
      <div className="wallet-form">
        <AmountField id="add-a" label={S.liquidity.amount(pool.token_a)} symbol={pool.token_a} value={a} balance={balA} onChange={onA} error={ca.error} />
        <AmountField id="add-b" label={S.liquidity.amount(pool.token_b)} symbol={pool.token_b} value={b} balance={balB} onChange={onB} error={cb.error} />
        <p className="form-hint">{seeded ? S.liquidity.ratioHint : S.liquidity.firstLiquidity}</p>
        {ready && (
          <Review
            rows={[
              [S.liquidity.youDeposit, `${fmtAmount(ca.raw!, pool.token_a)} ${pool.token_a} + ${fmtAmount(cb.raw!, pool.token_b)} ${pool.token_b}`],
              ["LP", `≈ ${fmtLp(lp)}`],
              [S.pools.share, `${(poolShare(lp, { total_lp_supply: pool.total_lp_supply + lp }) * 100).toFixed(2)}%`],
            ]}
          />
        )}
        <SignNote kind={signing.kind} />
        <ErrorLine>{submit.error}</ErrorLine>
        <div className="actions dex-actions">
          <Button variant="outline" disabled={submit.busy} onClick={close}>
            {S.common.cancel}
          </Button>
          <Button
            disabled={!ready || submit.busy}
            onClick={() => submit.run(async () => void (await submitAddLiquidity(signing.wallet, pool.pool_id, ca.raw!, cb.raw!)), S.toasts.addFailed)}
          >
            {submit.busy ? S.liquidity.signing : S.liquidity.signAdd}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function RemoveLiquidityDialog({
  pool,
  signing,
  lpBalance,
  onClose,
  onDone,
}: {
  pool: Pool | null;
  signing: Signing;
  lpBalance: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const close = () => {
    setAmount("");
    submit.setError("");
    onClose();
  };
  const submit = useSubmit(() => {
    toast.success(S.toasts.removed, { description: S.common.submittedNextBlock });
    close();
    onDone();
  });
  const parsed = useMemo(() => (amount.trim() ? parseLpAmount(amount) : null), [amount]);
  if (!pool) return null;
  const raw = parsed?.ok ? parsed.raw : null;
  const error = parsed && !parsed.ok ? parsed.error : raw !== null && raw > lpBalance ? S.liquidity.lpExceeds : "";
  const est = raw ? removeEstimate(raw, pool) : { a: 0, b: 0 };
  const ready = raw !== null && !error && est.a > 0 && est.b > 0;
  return (
    <Dialog open onClose={() => !submit.busy && close()} title={S.liquidity.removeTitle(pairName(pool))}>
      <div className="wallet-form">
        <label className="field" htmlFor="remove-lp">
          <span className="field-row">
            {S.liquidity.lpAmount}
            <span className="form-hint">{S.liquidity.lpBalance(fmtLp(lpBalance))}</span>
          </span>
          <input
            id="remove-lp"
            className="input mono"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            value={amount}
            aria-invalid={!!error}
            onChange={(e) => setAmount(e.target.value)}
          />
          {error && <span className="form-hint error">{error}</span>}
        </label>
        <div className="chip-row" role="group" aria-label={S.liquidity.lpAmount}>
          {[25, 50, 75, 100].map((pct) => (
            <button type="button" key={pct} className="chip" onClick={() => setAmount(String(Math.floor((lpBalance * pct) / 100)))}>
              {pct}%
            </button>
          ))}
        </div>
        {raw !== null && !error && (
          <Review
            rows={[
              [S.liquidity.youReceive, `${fmtAmount(est.a, pool.token_a)} ${pool.token_a}`],
              ["", `${fmtAmount(est.b, pool.token_b)} ${pool.token_b}`],
            ]}
          />
        )}
        <SignNote kind={signing.kind} />
        <ErrorLine>{submit.error}</ErrorLine>
        <div className="actions dex-actions">
          <Button variant="outline" disabled={submit.busy} onClick={close}>
            {S.common.cancel}
          </Button>
          <Button
            disabled={!ready || submit.busy}
            onClick={() => submit.run(async () => void (await submitRemoveLiquidity(signing.wallet, pool.pool_id, raw!)), S.toasts.removeFailed)}
          >
            {submit.busy ? S.liquidity.signing : S.liquidity.signRemove}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function CollectFeesDialog({
  pool,
  earned,
  signing,
  onClose,
  onDone,
}: {
  pool: Pool | null;
  earned: LpEarnings | null | undefined;
  signing: Signing;
  onClose: () => void;
  onDone: () => void;
}) {
  const submit = useSubmit(() => {
    if (pool && earned)
      toast.success(S.toasts.collected, {
        description: S.toasts.collectedBody(`${fmtAmount(earned.earnedA, pool.token_a)} ${pool.token_a}`, `${fmtAmount(earned.earnedB, pool.token_b)} ${pool.token_b}`),
      });
    onClose();
    onDone();
  });
  if (!pool) return null;
  const ok = canCollect(earned ?? null);
  return (
    <Dialog open onClose={() => !submit.busy && onClose()} title={S.liquidity.collectTitle(pairName(pool))}>
      <div className="wallet-form">
        {ok ? (
          <>
            <Review
              rows={[
                [S.liquidity.youReceive, `${fmtAmount(earned!.earnedA, pool.token_a)} ${pool.token_a}`],
                ["", `${fmtAmount(earned!.earnedB, pool.token_b)} ${pool.token_b}`],
                ["LP", fmtLp(earned!.lpToCollect)],
              ]}
            />
            <p className="form-hint">{S.liquidity.collectBody(`${(earned!.growth * 100).toFixed(4)}%`, fmtLp(earned!.lpToCollect))}</p>
          </>
        ) : (
          <p className="form-hint">{S.pools.nothingToCollect}</p>
        )}
        <SignNote kind={signing.kind} />
        <ErrorLine>{submit.error}</ErrorLine>
        <div className="actions dex-actions">
          <Button variant="outline" disabled={submit.busy} onClick={onClose}>
            {S.common.cancel}
          </Button>
          <Button
            disabled={!ok || submit.busy}
            onClick={() => submit.run(async () => void (await submitCollectFees(signing.wallet, pool.pool_id, earned!)), S.toasts.collectFailed)}
          >
            {submit.busy ? S.liquidity.signing : S.liquidity.signCollect}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function CreatePoolDialog({
  open,
  signing,
  balances,
  tokens,
  pools,
  onClose,
  onDone,
}: {
  open: boolean;
  signing: Signing;
  balances: Record<string, number>;
  tokens: string[];
  pools: Pool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [tokenA, setTokenA] = useState("XRGE");
  const [tokenB, setTokenB] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const close = () => {
    setA("");
    setB("");
    submit.setError("");
    onClose();
  };
  const submit = useSubmit(() => {
    close();
    onDone();
  });
  const ca = check(a, tokenA, balances[tokenA] ?? 0);
  const cb = tokenB ? check(b, tokenB, balances[tokenB] ?? 0) : { raw: null, error: "" };
  const same = !!tokenB && tokenA === tokenB;
  const existing = tokenB && !same ? pools.find((p) => p.pool_id === makePoolId(tokenA, tokenB)) : undefined;
  const ready = !!tokenB && !same && !existing && ca.raw !== null && cb.raw !== null && !ca.error && !cb.error;
  const options = (other: string) =>
    tokens.map((t) => (
      <option key={t} value={t} disabled={t === other}>
        {t} · {fmtAmount(balances[t] ?? 0, t)}
      </option>
    ));
  return (
    <Dialog open={open} onClose={() => !submit.busy && close()} title={S.liquidity.createTitle}>
      <div className="wallet-form">
        <div className="two-fields dex-two">
          <label className="field">
            {S.liquidity.tokenA}
            <select className="input" value={tokenA} onChange={(e) => setTokenA(e.target.value)}>
              {options(tokenB)}
            </select>
          </label>
          <label className="field">
            {S.liquidity.tokenB}
            <select className="input" value={tokenB} onChange={(e) => setTokenB(e.target.value)}>
              <option value="">{S.swap.selectToken}</option>
              {options(tokenA)}
            </select>
          </label>
        </div>
        <AmountField id="create-a" label={S.liquidity.amount(tokenA)} symbol={tokenA} value={a} balance={balances[tokenA] ?? 0} onChange={setA} error={ca.error} />
        {tokenB && (
          <AmountField id="create-b" label={S.liquidity.amount(tokenB)} symbol={tokenB} value={b} balance={balances[tokenB] ?? 0} onChange={setB} error={cb.error} />
        )}
        {same && <p className="form-hint error">{S.liquidity.differentTokens}</p>}
        {existing && <p className="form-hint error">{S.liquidity.poolExists(existing.pool_id)}</p>}
        {ready && (
          <Review
            rows={[
              ["Pool", makePoolId(tokenA, tokenB)],
              [S.liquidity.youDeposit, `${fmtAmount(ca.raw!, tokenA)} ${tokenA} + ${fmtAmount(cb.raw!, tokenB)} ${tokenB}`],
              ["LP", `≈ ${fmtLp(lpForDeposit(ca.raw!, cb.raw!))}`],
            ]}
          />
        )}
        <p className="form-hint">{S.liquidity.createFee}</p>
        <SignNote kind={signing.kind} />
        <ErrorLine>{submit.error}</ErrorLine>
        <div className="actions dex-actions">
          <Button variant="outline" disabled={submit.busy} onClick={close}>
            {S.common.cancel}
          </Button>
          <Button
            disabled={!ready || submit.busy}
            onClick={() =>
              submit.run(async () => {
                const data = await submitCreatePool(signing.wallet, tokenA, tokenB, ca.raw!, cb.raw!);
                toast.success(S.toasts.created(data?.pool_id ?? makePoolId(tokenA, tokenB)), { description: S.common.submittedNextBlock });
              }, S.toasts.createFailed)
            }
          >
            {submit.busy ? S.liquidity.signing : S.liquidity.signCreate}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
