import { useCallback, useState } from "react";

const STORAGE_KEY = "rougechain-hide-balances";

/** Placeholder shown instead of an amount while balances are hidden. */
export const MASKED_AMOUNT = "••••••";

function readHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** "Hide balances" privacy toggle for the wallet page, remembered per browser (localStorage). */
export function useHideBalances(): { hidden: boolean; toggle: () => void } {
  const [hidden, setHidden] = useState<boolean>(readHidden);
  const toggle = useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(STORAGE_KEY, "1");
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable: the toggle still works for this visit */
      }
      return next;
    });
  }, []);
  return { hidden, toggle };
}
