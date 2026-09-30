import { Route } from "react-router-dom";
import Swap from "../Swap";
import SwapSections from "../SwapSections";
import type { FeatureArea } from "./types";

/** Swap, pools, positions (and /buy once ported). Owner: the swap area. */
export const swapArea: FeatureArea = {
  routes: [
    <Route key="swap" path="/swap" element={<Swap />} />,
    <Route
      key="swap-pools"
      path="/swap/pools"
      element={<SwapSections section="pools" />}
    />,
    <Route
      key="swap-positions"
      path="/swap/positions"
      element={<SwapSections section="positions" />}
    />,
  ],
  headerProduct: (pathname) =>
    pathname === "/swap" || pathname.startsWith("/swap/") ? "Swap" : null,
};
