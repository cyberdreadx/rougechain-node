/**
 * App-wide "Received X from Y" toasts (port of apps/web's IncomingTransferWatcher +
 * use-incoming-transfer-notifications). Each new block is fetched on its own through core's
 * getWalletTransactionsInBlocks and matched with core's incoming-transfers helpers; only blocks
 * after the wallet / network was selected are announced.
 */
import { useCallback, useEffect, useRef } from "react";
import { findNewIncoming, idSet } from "@rougechain/core/incoming-transfers";
import { getWalletTransactionsInBlocks } from "@rougechain/core/pqc-wallet";
import { loadNotificationSettings, playNotificationSound, showDesktopNotification } from "@rougechain/core/notifications";
import { formatAddress, pubkeyToAddress } from "@rougechain/core/address";
import { useWallet } from "./WalletProvider";
import { useNewBlocks, useRougeAddress } from "./hooks";
import { toast } from "./toast";
import i18n from "../i18n";

/** Tolerance for node vs browser clock when ignoring transfers older than the watch start. */
const CLOCK_SLACK_MS = 2 * 60_000;
/** Blocks scanned per new-block event at most (after a gap, e.g. a sleeping tab). */
const MAX_BLOCKS_PER_SCAN = 5;

export async function shortSender(from: string | undefined): Promise<string> {
  if (!from) return "?";
  if (/^[A-Z]+$/.test(from)) return from; // FAUCET / BRIDGE / GENESIS
  if (from.toLowerCase().startsWith("rouge1")) return formatAddress(from);
  try {
    return formatAddress(await pubkeyToAddress(from));
  } catch {
    return `${from.slice(0, 8)}…${from.slice(-4)}`;
  }
}

export function IncomingTransferWatcher() {
  const { publicKey, network } = useWallet();
  const { full: rougeAddress } = useRougeAddress(publicKey);
  const walletKey = publicKey ? `${network}|${publicKey}|${rougeAddress ?? ""}` : null;

  const state = useRef({ key: null as string | null, since: 0, lastHeight: null as number | null, seen: new Set<string>() });
  useEffect(() => {
    state.current = { key: walletKey, since: Date.now(), lastHeight: null, seen: new Set() };
  }, [walletKey]);

  const onNewBlock = useCallback(
    async (height: number) => {
      const s = state.current;
      const key = s.key;
      const prev = s.lastHeight;
      if (prev === null || height > prev) s.lastHeight = height;
      if (!key || !publicKey || prev === null || height <= prev) return; // first height = baseline
      const from = Math.max(prev + 1, height - MAX_BLOCKS_PER_SCAN + 1);
      const txs = await getWalletTransactionsInBlocks(from, height, publicKey, rougeAddress ? [rougeAddress] : []);
      if (state.current.key !== key || txs.length === 0) return;
      const fresh = findNewIncoming(txs, s.seen, idSet([publicKey, rougeAddress]), s.since - CLOCK_SLACK_MS);
      if (fresh.length === 0) return;
      const settings = loadNotificationSettings();
      if (!settings.enabled) return;
      if (settings.sound) playNotificationSound();
      for (const tx of fresh) {
        void shortSender(tx.from).then((sender) => {
          const body = i18n.t("wallet:incoming.body", { amount: tx.amount, symbol: tx.symbol, sender });
          toast.success(body);
          if (settings.desktopEnabled && document.hidden) showDesktopNotification(i18n.t("wallet:incoming.title"), body);
        });
      }
    },
    [publicKey, rougeAddress],
  );

  useNewBlocks(network, onNewBlock, !!walletKey);
  return null;
}

