/**
 * The /shield page's session: one worker (via `ShieldHost`), the rounds of the loop, and the
 * payments. Rounds are the loop's cadence; nothing here ends an embargo, releases a lock or
 * retries a payment by time (UI_CONTRACT obligation 3, limit 6): a retry is step 5 of a round
 * (the same stored envelope) or the user's own "submit again".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentResult, ShieldViewModel } from "./client";
import { INACTIVE_RECHECK_MS, ROUND_INTERVAL_MS, SLOW_ROUND_INTERVAL_MS } from "./config";
import { ShieldHost, bip39Seed, type WorkerFactory } from "./host";
import type { SessionData } from "./loop";

export type Phase = "starting" | "ready" | "proving" | "error" | "other_tab";

export interface ShieldSession {
  phase: Phase;
  view: ShieldViewModel | null;
  address: string | null;
  fingerprint: string | null;
  error: string | null;
  lastResult: PaymentResult | null;
  transfer(recipient: string, amount: string, fee: string): Promise<PaymentResult | null>;
  unshield(to: string, amount: string, fee: string): Promise<PaymentResult | null>;
  shield(vIn: string, fee: string, fromPubKey: string, sign: (hex: string) => Promise<string>): Promise<PaymentResult | null>;
  resubmit(id: string): Promise<void>;
  confirmSoleCopy(): Promise<boolean>;
  tryAgain(): Promise<void>;
  parseAddress(a: string): Promise<{ fingerprint: string } | null>;
}

export function useShieldSession(o: { mnemonic: string | null; network: string; origins: string[]; enabled: boolean; factory?: WorkerFactory }): ShieldSession {
  const { mnemonic, network, origins, enabled, factory } = o;
  const host = useRef<ShieldHost | null>(null);
  const busy = useRef(false);
  const timer = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [view, setView] = useState<ShieldViewModel | null>(null);
  const [ident, setIdent] = useState<{ address: string; fingerprint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PaymentResult | null>(null);
  const originsKey = origins.join(" ");

  const init = useCallback(
    async (session: SessionData | null) => {
      const h = host.current!;
      const seed = await bip39Seed(mnemonic!);
      const r = await h.ask({ cmd: "init", network, seed, origins: originsKey ? originsKey.split(" ") : [], session }, [seed.buffer]);
      if (!r.ok) throw new Error(r.error ?? "init failed");
      setIdent({ address: r.address!, fingerprint: r.fingerprint! });
      if (r.view) setView(r.view);
      return r;
    },
    [mnemonic, network, originsKey],
  );

  const schedule = useCallback((ms: number, recheckPool = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void runRef.current(recheckPool), ms);
  }, []);

  const runRound = useCallback(
    async (recheckPool = false) => {
      const h = host.current;
      if (!h) return;
      if (busy.current) return schedule(ROUND_INTERVAL_MS);
      const r = await h.ask({ cmd: "round", recheckPool });
      if (host.current !== h) return;
      if (!r.ok) {
        setError(r.error ?? "round failed");
        return schedule(SLOW_ROUND_INTERVAL_MS);
      }
      const v = r.view!;
      setView(v);
      if (v.nodes.length < 3) return; // read-only: no loop
      if (v.stop?.kind === "pool_inactive") return schedule(INACTIVE_RECHECK_MS, true);
      if (v.stop) return; // no honest listing node / fault: until the user's "try again"
      schedule(v.events.some((e) => e.startsWith("left") || e.startsWith("banned")) ? SLOW_ROUND_INTERVAL_MS : ROUND_INTERVAL_MS);
    },
    [schedule],
  );
  const runRef = useRef(runRound);
  runRef.current = runRound;

  useEffect(() => {
    if (!enabled || !mnemonic) return;
    let h: ShieldHost | null = null;
    let closed = false;
    let release: () => void = () => {};
    setPhase("starting");
    setError(null);
    const start = () => {
      if (closed) return;
      h = new ShieldHost(factory);
      host.current = h;
      init(null)
        .then(() => {
          setPhase("ready");
          return runRef.current();
        })
        .catch((e: unknown) => {
          setPhase("error");
          setError(e instanceof Error ? e.message : String(e));
        });
    };
    // One tab per network runs the shielded wallet: two loops over one stored state can blame an
    // honest node for another tab's listing (review of 2026-10-18). Without the Web Locks API
    // (very old browsers, tests) the stored-revision checks still refuse a stale write.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      void locks
        .request(`rougechain-shield-v2:${network}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            if (!closed) setPhase("other_tab");
            return;
          }
          start();
          return new Promise<void>((resolve) => {
            release = resolve;
            if (closed) resolve();
          });
        })
        .catch(() => start());
    } else start();
    return () => {
      closed = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      host.current = null;
      h?.terminate(); // leaving the page: the worker and its memory go
      release();
    };
  }, [enabled, mnemonic, network, init, factory]);

  /** A payment: proving in the worker, then the worker is recycled (memory is never returned). */
  const pay = useCallback(
    async (run: (h: ShieldHost) => Promise<PaymentResult | null>): Promise<PaymentResult | null> => {
      const h = host.current;
      if (!h || busy.current) return null;
      busy.current = true;
      setPhase("proving");
      try {
        const result = await run(h);
        setLastResult(result);
        await h.recycle(init);
        setPhase("ready");
        void runRef.current();
        return result;
      } catch (e) {
        setPhase("error");
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        busy.current = false;
      }
    },
    [init],
  );

  const transfer = useCallback(
    (recipient: string, amount: string, fee: string) =>
      pay(async (h) => {
        const seed = await bip39Seed(mnemonic!);
        const r = await h.ask({ cmd: "transfer", seed, recipient, amount, fee }, [seed.buffer]);
        if (r.view) setView(r.view);
        return r.result ?? null;
      }),
    [pay, mnemonic],
  );
  const unshield = useCallback(
    (to: string, amount: string, fee: string) =>
      pay(async (h) => {
        const seed = await bip39Seed(mnemonic!);
        const r = await h.ask({ cmd: "unshield", seed, to, amount, fee }, [seed.buffer]);
        if (r.view) setView(r.view);
        return r.result ?? null;
      }),
    [pay, mnemonic],
  );
  const shield = useCallback(
    (vIn: string, fee: string, fromPubKey: string, sign: (hex: string) => Promise<string>) =>
      pay(async (h) => {
        const p = await h.ask({ cmd: "prepareShield", fromPubKey, vIn, fee });
        if (p.view) setView(p.view);
        if (!p.shield || p.shield.status !== "sign") return (p.shield as PaymentResult) ?? null;
        const sig = await sign(p.shield.signing_bytes);
        const r = await h.ask({ cmd: "completeShield", sig });
        if (r.view) setView(r.view);
        return r.result ?? null;
      }),
    [pay],
  );

  const resubmit = useCallback(async (id: string) => {
    const r = await host.current?.ask({ cmd: "resubmit", paymentId: id });
    if (r?.view) setView(r.view);
  }, []);
  const confirmSoleCopy = useCallback(async () => {
    const r = await host.current?.ask({ cmd: "soleCopy", userConfirmedTheStatement: true });
    if (r?.view) setView(r.view);
    void runRef.current();
    return !!r?.done;
  }, []);
  const tryAgain = useCallback(async () => {
    const r = await host.current?.ask({ cmd: "newSession" });
    if (r?.view) setView(r.view);
    void runRef.current();
  }, []);
  const parseAddress = useCallback(async (a: string) => {
    const r = await host.current?.ask({ cmd: "parseAddress", address: a });
    return r?.ok && r.parsed ? r.parsed : null;
  }, []);

  return { phase, view, address: ident?.address ?? null, fingerprint: ident?.fingerprint ?? null, error, lastResult, transfer, unshield, shield, resubmit, confirmSoleCopy, tryAgain, parseAddress };
}
