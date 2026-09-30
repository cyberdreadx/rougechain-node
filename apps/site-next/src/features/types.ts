import type { ReactElement } from "react";

/**
 * One feature area of the site (swap, bridge, messenger/mail, validators & pages). Each area owns
 * its file in src/features/ so areas can be built in parallel without editing App.tsx:
 *  - `routes`: its <Route> elements (keep paths identical to apps/web so links and redirects work)
 *  - `headerProduct(pathname)`: the app-registry product whose AppHeader these paths use
 *    (e.g. "Swap"), or null for paths it doesn't own (marketing header / other areas).
 */
export interface FeatureArea {
  routes: ReactElement[];
  headerProduct(pathname: string): string | null;
}
