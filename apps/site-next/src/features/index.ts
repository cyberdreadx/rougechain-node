import { swapArea } from "./swap";
import { bridgeArea } from "./bridge";
import { messengerArea } from "./messenger";
import { pagesArea } from "./pages";
import type { FeatureArea } from "./types";

const areas: FeatureArea[] = [swapArea, bridgeArea, messengerArea, pagesArea];

export const featureRoutes = areas.flatMap((a) => a.routes);

/** The AppHeader product for a path owned by a feature area, or null. */
export function featureHeaderProduct(pathname: string): string | null {
  for (const a of areas) {
    const p = a.headerProduct(pathname);
    if (p) return p;
  }
  return null;
}
