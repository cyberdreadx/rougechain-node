import { useCallback, useEffect, useRef, useState } from "react";
import { useBlockchainWs, type WsNewBlockEvent } from "@/hooks/use-blockchain-ws";
import { useIncomingTransferNotifications } from "@/hooks/use-incoming-transfer-notifications";
import { useRougeAddress } from "@/hooks/useRougeAddress";
import { getActiveNetwork } from "@/lib/network";
import { getWalletTransactionsInBlocks, type WalletTransaction } from "@/lib/pqc-wallet";
import { getLockedWalletMetadata, loadUnifiedWallet } from "@/lib/unified-wallet";

/** How often to re-read which wallet is connected (connect / disconnect / lock happen in pages). */
const WALLET_CHECK_MS = 3000;
/** Blocks scanned per new-block event at most (after a gap, e.g. a sleeping tab). */
const MAX_BLOCKS_PER_SCAN = 5;

function connectedPubkey(): string | null {
  try {
    return loadUnifiedWallet()?.signingPublicKey || getLockedWalletMetadata()?.signingPublicKey || null;
  } catch {
    return null;
  }
}

/**
 * App-wide "Received X from Y" toasts, on every page. Each new block is fetched on its own
 * (`/api/block/:h`) and checked for transfers to the connected wallet; the full history is never
 * reloaded. The network is fixed for the page's lifetime (switching networks reloads the page).
 */
export function IncomingTransferWatcher() {
  const [pubkey, setPubkey] = useState<string | null>(connectedPubkey);
  useEffect(() => {
    const id = window.setInterval(() => setPubkey(connectedPubkey()), WALLET_CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  const { full: rougeAddress } = useRougeAddress(pubkey);
  const walletKey = pubkey ? `${getActiveNetwork()}|${pubkey}|${rougeAddress ?? ""}` : null;

  const [feed, setFeed] = useState<{ txs: WalletTransaction[]; at: number | null }>({ txs: [], at: null });
  useIncomingTransferNotifications({
    walletKey,
    myIds: [pubkey, rougeAddress],
    transactions: feed.txs,
    loadedAt: feed.at,
  });

  // A new wallet starts from an empty baseline: only blocks after this point are announced.
  const lastHeight = useRef<number | null>(null);
  const keyRef = useRef(walletKey);
  useEffect(() => {
    keyRef.current = walletKey;
    lastHeight.current = null;
    setFeed({ txs: [], at: Date.now() });
  }, [walletKey]);

  const onNewBlock = useCallback(async (event: WsNewBlockEvent) => {
    const key = keyRef.current;
    const prev = lastHeight.current;
    if (prev === null || event.height > prev) lastHeight.current = event.height;
    if (!key || !pubkey || prev === null || event.height <= prev) return;
    const from = Math.max(prev + 1, event.height - MAX_BLOCKS_PER_SCAN + 1);
    const txs = await getWalletTransactionsInBlocks(from, event.height, pubkey, rougeAddress ? [rougeAddress] : []);
    if (keyRef.current !== key || txs.length === 0) return;
    setFeed({ txs, at: Date.now() });
  }, [pubkey, rougeAddress]);

  useBlockchainWs({ onNewBlock, topics: ["blocks"], fallbackPollInterval: 15000 });
  return null;
}
