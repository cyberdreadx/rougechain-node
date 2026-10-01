/** Dialog state for add / remove / collect / create, shared by the Pools and Pool detail pages. */
import { useState } from "react";
import type { DexBalances, LpEarnings, Pool } from "./api";
import type { SignState } from "./hooks";
import { AddLiquidityDialog, CollectFeesDialog, CreatePoolDialog, RemoveLiquidityDialog } from "./LiquidityDialogs";

type Open = { kind: "add" | "remove" | "collect"; pool: Pool } | { kind: "create" } | null;

export function useLiquidityActions(opts: {
  sign: SignState;
  balances: DexBalances | undefined;
  earnings: Record<string, LpEarnings | null> | undefined;
  pools: Pool[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState<Open>(null);
  const { sign, balances, earnings, pools, onDone } = opts;
  const held: Record<string, number> = balances ? { XRGE: balances.xrge, ...balances.tokens } : {};
  const close = () => setOpen(null);
  const tokens = [...new Set(["XRGE", ...Object.keys(held).filter((s) => held[s] > 0), ...pools.flatMap((p) => [p.token_a, p.token_b])])];

  const dialogs =
    sign.state !== "ready" || !open ? null : open.kind === "add" ? (
      <AddLiquidityDialog pool={open.pool} signing={sign} balances={held} onClose={close} onDone={onDone} />
    ) : open.kind === "remove" ? (
      <RemoveLiquidityDialog pool={open.pool} signing={sign} lpBalance={balances?.lp[open.pool.pool_id] ?? 0} onClose={close} onDone={onDone} />
    ) : open.kind === "collect" ? (
      <CollectFeesDialog pool={open.pool} earned={earnings?.[open.pool.pool_id]} signing={sign} onClose={close} onDone={onDone} />
    ) : (
      <CreatePoolDialog open signing={sign} balances={held} tokens={tokens} pools={pools} onClose={close} onDone={onDone} />
    );

  return {
    dialogs,
    add: (pool: Pool) => setOpen({ kind: "add", pool }),
    remove: (pool: Pool) => setOpen({ kind: "remove", pool }),
    collect: (pool: Pool) => setOpen({ kind: "collect", pool }),
    create: () => setOpen({ kind: "create" }),
  };
}
