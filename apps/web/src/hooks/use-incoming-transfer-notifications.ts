import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { WalletTransaction } from "@/lib/pqc-wallet";
import type { WsNewTransactionEvent } from "@/hooks/use-blockchain-ws";
import { findNewIncoming, idSet, isIncomingFrame, txKey } from "@/lib/incoming-transfers";
import { loadNotificationSettings, playNotificationSound, showDesktopNotification } from "@/lib/notifications";
import { formatAddress, pubkeyToAddress } from "@/lib/address";

/** Tolerance for node vs browser clock when ignoring transfers older than the watch start. */
const CLOCK_SLACK_MS = 2 * 60_000;
const MAX_FRAMES = 200;

async function shortSender(from: string | undefined): Promise<string> {
  if (!from) return "?";
  if (/^[A-Z]+$/.test(from)) return from; // FAUCET / BRIDGE / GENESIS
  if (from.toLowerCase().startsWith("rouge1")) return formatAddress(from);
  try {
    return formatAddress(await pubkeyToAddress(from));
  } catch {
    return `${from.slice(0, 8)}…${from.slice(-4)}`;
  }
}

/**
 * Toast "Received X SYMBOL from <sender>" when the connected wallet receives a transfer
 * (plus a sound / browser notification per the messenger's notification settings).
 *
 * Source of truth is the wallet's refreshed history (it carries the token + human amount); the
 * first history loaded for a wallet/network is the baseline and is never announced. Websocket
 * `NewTransaction` frames for my account topics only trigger an early refresh — pass them to
 * the returned `onTxFrame`, which de-duplicates by tx hash and returns true when a refresh
 * is worthwhile.
 */
export function useIncomingTransferNotifications(opts: {
  /** Changes when the wallet, its resolved address or the network changes (resets the baseline). */
  walletKey: string | null;
  /** My ids: signing public key and rouge1 address. */
  myIds: Array<string | null | undefined>;
  transactions: WalletTransaction[];
  /** When `transactions` was last (successfully) loaded; null before the first load. */
  loadedAt: number | null;
}): { onTxFrame: (frame: WsNewTransactionEvent) => boolean } {
  const { t } = useTranslation();
  const { walletKey, transactions, loadedAt } = opts;
  const idsKey = opts.myIds.filter(Boolean).join("|");
  const mine = useMemo(() => idSet(idsKey.split("|")), [idsKey]);

  const state = useRef({
    key: null as string | null,
    since: 0,
    baselined: false,
    seen: new Set<string>(),
    frames: new Set<string>(),
  });
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const s = state.current;
    if (s.key !== walletKey) {
      s.key = walletKey;
      s.since = Date.now();
      s.baselined = false;
      s.seen = new Set();
      s.frames = new Set();
    }
    // Only lists loaded after this wallet/network was selected count.
    if (!walletKey || loadedAt === null || loadedAt < s.since) return;
    if (!s.baselined) {
      for (const tx of transactions) s.seen.add(txKey(tx));
      s.baselined = true;
      return;
    }
    const fresh = findNewIncoming(transactions, s.seen, mine, s.since - CLOCK_SLACK_MS);
    if (fresh.length === 0) return;
    const settings = loadNotificationSettings();
    if (!settings.enabled) return;
    if (settings.sound) playNotificationSound();
    for (const tx of fresh) {
      void shortSender(tx.from).then((from) => {
        const tr = tRef.current;
        const body = tr("wallet.notifications.received", { amount: tx.amount, symbol: tx.symbol, from });
        toast.success(body);
        if (settings.desktopEnabled && typeof document !== "undefined" && document.hidden) {
          showDesktopNotification(tr("wallet.notifications.receivedTitle"), body);
        }
      });
    }
  }, [walletKey, loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTxFrame = useCallback(
    (frame: WsNewTransactionEvent): boolean => {
      const s = state.current;
      if (!s.key || !isIncomingFrame(frame, mine)) return false;
      if (s.frames.has(frame.tx_hash)) return false;
      if (s.frames.size >= MAX_FRAMES) s.frames.clear();
      s.frames.add(frame.tx_hash);
      return true;
    },
    [mine],
  );

  return { onTxFrame };
}
