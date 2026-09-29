import { createContext, useContext, useState, type ReactNode } from "react";
export const DEMO_WALLET_KEY = "rougechain-poc-demo-wallet-v1";
export const DEMO_ADDRESS = "rouge1_demo_only_not_an_onchain_account_7d3a";
export const DEMO_SHORT_ADDRESS = "rouge1demo…7d3a";
export type DemoSource = "extension" | "qwalla";
export interface DemoWalletState {
  connected: boolean;
  address: string | null;
  source: DemoSource | null;
}
const disconnected: DemoWalletState = {
  connected: false,
  address: null,
  source: null,
};
function readDemoState(): DemoWalletState {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(DEMO_WALLET_KEY) ?? "null",
    );
    if (
      value?.connected === true &&
      value.address === DEMO_ADDRESS &&
      (value.source === "extension" || value.source === "qwalla")
    )
      return { connected: true, address: DEMO_ADDRESS, source: value.source };
  } catch {
    /* Optional session storage; memory-only demo remains usable. */
  }
  return disconnected;
}
const Context = createContext<
  | (DemoWalletState & {
      connectDemo: (source: DemoSource) => void;
      disconnectDemo: () => void;
    })
  | null
>(null);
// POC ONLY: synthetic identity/session state. Do not port as a production provider.
export function DemoWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(readDemoState);
  const update = (next: DemoWalletState) => {
    setState(next);
    try {
      if (next.connected)
        window.sessionStorage.setItem(DEMO_WALLET_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(DEMO_WALLET_KEY);
    } catch {
      /* No credentials or private information are persisted. */
    }
  };
  return (
    <Context.Provider
      value={{
        ...state,
        connectDemo: (source) =>
          update({ connected: true, address: DEMO_ADDRESS, source }),
        disconnectDemo: () => update(disconnected),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useDemoWallet() {
  const context = useContext(Context);
  if (!context) throw Error("DemoWalletProvider is required");
  return context;
}
