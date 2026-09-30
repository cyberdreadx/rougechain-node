/**
 * The Base (EVM) side of the bridge: an injected wallet (EIP-6963 / window.ethereum), or the
 * "Use my RougeChain Base wallet" local provider from core (key derived from the recovery phrase,
 * every transaction / signature approved in ApprovalDialog) — exactly as apps/web's Bridge page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createLocalBaseProvider, type LocalBaseRequest } from "@rougechain/core/base-local-provider";
import { getBaseChainConfig } from "@rougechain/core/bridge";
import { deriveBaseAddress, hasBaseAccount } from "@rougechain/core/evm-wallet";
import { getBaseChain } from "@rougechain/core/base-wallet";
import { loadUnifiedWallet } from "@rougechain/core/unified-wallet";
import type { NetworkType } from "@rougechain/core/network";
import {
  balanceOfCalldata,
  legacyEthereum,
  legacyWalletName,
  pickWallet,
  readChainId,
  useEip6963Wallets,
  type Eip1193Provider,
  type Eip6963Detail,
} from "./evm";
import { errorMessage } from "./flows";

export interface PendingApproval {
  req: LocalBaseRequest;
  resolve: (ok: boolean) => void;
}

export interface BaseConnection {
  discovered: Eip6963Detail[];
  selectedRdns: string | null;
  select(rdns: string): void;
  walletName: string;
  /** A provider exists to connect with (injected or local). */
  hasInjected: boolean;
  localAvailable: boolean;
  mode: "injected" | "local" | null;
  address: string | null;
  provider: Eip1193Provider | undefined;
  /** The wallet's current chain id (null until read). */
  walletChainId: number | null;
  wrongChain: boolean;
  connecting: boolean;
  error: string | null;
  connectInjected(): Promise<void>;
  connectLocal(): void;
  disconnect(): void;
  pendingApproval: PendingApproval | null;
  resolveApproval(ok: boolean): void;
}

function mnemonicNow(): string | undefined {
  try {
    return loadUnifiedWallet()?.mnemonic;
  } catch {
    return undefined;
  }
}

export function useBaseConnection(opts: { chainId: number; network: NetworkType; mnemonic: string | null | undefined; onConnected?: (address: string) => void }): BaseConnection {
  const { chainId, network, mnemonic, onConnected } = opts;
  const { t } = useTranslation("bridge");
  const discovered = useEip6963Wallets();
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);
  const [mode, setMode] = useState<"injected" | "local" | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  const localChain = useMemo(() => getBaseChain(network), [network]);
  const localAvailable = useMemo(() => hasBaseAccount(mnemonic), [mnemonic]);
  const selected = pickWallet(discovered, selectedRdns);
  const legacy = legacyEthereum();
  const walletName = selected?.info.name ?? legacyWalletName(legacy) ?? t("form.baseWallet");

  const localProvider = useMemo(() => {
    if (mode !== "local") return null;
    return createLocalBaseProvider({
      chain: localChain,
      getMnemonic: mnemonicNow,
      confirm: (req) => new Promise<boolean>((resolve) => setPendingApproval({ req, resolve })),
    });
  }, [mode, localChain]);

  const injected: Eip1193Provider | undefined = selected?.provider ?? legacy;
  const provider = mode === "local" ? (localProvider ?? undefined) : mode === "injected" ? injected : undefined;

  // Follow account / chain changes of an injected wallet.
  useEffect(() => {
    if (mode !== "injected" || !injected?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const list = args[0] as string[] | undefined;
      if (!list || list.length === 0) {
        setMode(null);
        setAddress(null);
      } else setAddress(list[0]);
    };
    const onChain = (...args: unknown[]) => {
      const raw = args[0];
      const n = typeof raw === "string" ? parseInt(raw, 16) : typeof raw === "number" ? raw : NaN;
      setWalletChainId(Number.isFinite(n) ? n : null);
    };
    injected.on("accountsChanged", onAccounts);
    injected.on("chainChanged", onChain);
    return () => {
      injected.removeListener?.("accountsChanged", onAccounts);
      injected.removeListener?.("chainChanged", onChain);
    };
  }, [mode, injected]);

  const connectInjected = useCallback(async () => {
    setError(null);
    const p = injected;
    if (!p) {
      setError(t("form.noProvider"));
      return;
    }
    setConnecting(true);
    try {
      const cfg = getBaseChainConfig(chainId);
      const chainIdHex = `0x${chainId.toString(16)}`;
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(async () => {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: chainIdHex, chainName: cfg.name, nativeCurrency: cfg.nativeCurrency, rpcUrls: [cfg.rpcUrls.default.http[0]], blockExplorerUrls: [cfg.blockExplorers.default.url] }],
        });
      });
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.[0]) throw new Error(t("errors.connectFailed"));
      const actual = await readChainId(p);
      setWalletChainId(actual);
      if (actual !== chainId) {
        // Refuse: the wallet stayed on another chain (switch declined / unsupported).
        setError(t("form.wrongChain", { actual: actual ?? t("unknownChain"), expected: chainId, chain: cfg.name }));
        return;
      }
      setMode("injected");
      setAddress(accounts[0]);
      onConnected?.(accounts[0]);
    } catch (e) {
      setError(errorMessage(e, t("errors.connectFailed")));
    } finally {
      setConnecting(false);
    }
  }, [injected, chainId, onConnected, t]);

  const connectLocal = useCallback(() => {
    setError(null);
    if (localChain.chainId !== chainId) {
      setError(t("errors.networkNotConfirmed"));
      return;
    }
    const addr = deriveBaseAddress(mnemonicNow());
    if (!addr) {
      setError(t("errors.connectRougeFirst"));
      return;
    }
    setMode("local");
    setAddress(addr);
    setWalletChainId(localChain.chainId);
    onConnected?.(addr);
  }, [chainId, localChain, onConnected, t]);

  const disconnect = useCallback(() => {
    setMode(null);
    setAddress(null);
    setWalletChainId(null);
    setError(null);
  }, []);

  const resolveApproval = useCallback(
    (ok: boolean) => {
      pendingApproval?.resolve(ok);
      setPendingApproval(null);
    },
    [pendingApproval],
  );

  return {
    discovered,
    selectedRdns: selected?.info.rdns ?? null,
    select: setSelectedRdns,
    walletName,
    hasInjected: !!injected,
    localAvailable,
    mode,
    address,
    provider,
    walletChainId,
    wrongChain: mode !== null && walletChainId !== null && walletChainId !== chainId,
    connecting,
    error,
    connectInjected,
    connectLocal,
    disconnect,
    pendingApproval,
    resolveApproval,
  };
}

export interface EvmBalances {
  eth: bigint | null;
  usdc: bigint | null;
  xrge: bigint | null;
}

/** Base balances of the connected account through its provider (apps/web refreshEvmBalances). */
export function useEvmBalances(provider: Eip1193Provider | undefined, address: string | null, usdcAddress: string, xrgeToken: string | undefined, refreshKey: number): EvmBalances {
  const [bal, setBal] = useState<EvmBalances & { key: string }>({ eth: null, usdc: null, xrge: null, key: "" });
  const key = `${address}|${usdcAddress}|${xrgeToken}|${refreshKey}`;
  useEffect(() => {
    if (!provider || !address) return;
    let cancelled = false;
    (async () => {
      const read = async (fn: () => Promise<unknown>) => {
        try {
          const v = await fn();
          return typeof v === "string" && v.startsWith("0x") ? BigInt(v === "0x" ? 0 : v) : null;
        } catch {
          return null;
        }
      };
      const data = balanceOfCalldata(address);
      const eth = await read(() => provider.request({ method: "eth_getBalance", params: [address, "latest"] }));
      const usdc = await read(() => provider.request({ method: "eth_call", params: [{ to: usdcAddress, data }, "latest"] }));
      const xrge = xrgeToken ? await read(() => provider.request({ method: "eth_call", params: [{ to: xrgeToken, data }, "latest"] })) : null;
      if (!cancelled) setBal({ eth, usdc, xrge, key });
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, address, usdcAddress, xrgeToken, key]);
  return bal.key === key && address ? bal : { eth: null, usdc: null, xrge: null };
}
