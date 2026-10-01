import { createContext, useContext, type ComponentType } from "react";
import type { NetworkId, TokenInfo } from "@rougechain/chain-readonly";

/** Props for an action the host site renders on a token page (e.g. the creator's "Mint"). */
export interface ExplorerTokenActionProps {
  token: TokenInfo;
  network: NetworkId;
  /** Re-read the token after the action (its result lands in a later block). */
  onChanged: () => void;
}

/**
 * Optional, host-provided UI for explorer pages. The main site (App) fills these with wallet
 * actions; the standalone explorer site provides none, so it stays read-only with no signing code.
 */
export interface ExplorerSlots {
  TokenActions?: ComponentType<ExplorerTokenActionProps>;
}

const SlotsContext = createContext<ExplorerSlots>({});

export const ExplorerSlotsProvider = SlotsContext.Provider;

export function useExplorerSlots(): ExplorerSlots {
  return useContext(SlotsContext);
}
