import type { FeatureArea } from "./types";

/** Bridge (Base + BTC deposits/withdrawals). Owner: the bridge area. Empty until that area lands. */
export const bridgeArea: FeatureArea = {
  routes: [],
  headerProduct: () => null,
};
