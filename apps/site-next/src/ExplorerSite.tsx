import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { RougeAppShell, Status, TextLink } from "@rougechain/ui";
import { ChainProvider } from "./explorer/chain";
import { NetworkProvider, useNetwork } from "./Network";
import Overview from "./explorer/Overview";
import { explorerRoutes, matchesPrefix } from "./explorer/routes";
import { BridgeActivityPage } from "./explorer/Bridge";
import { DOCS_URL, SOURCE_URL, appById } from "./ecosystem/apps";

/**
 * explorer.rougechain.io — the Explorer as a standalone, read-only site (VITE_APP_MODE=explorer).
 * Same pages and paths as the Explorer inside the main site, with "/" as the overview. No wallet,
 * no marketing, no signing: everything here is a read-only GET through @rougechain/chain-readonly.
 */
export const MAIN_SITE_URL = "https://rougechain.io";

const queryClient = new QueryClient();

/** The local-nav item whose `match` prefixes best fit the path, so detail pages light up their section. */
export function activeExplorerItem(
  pathname: string,
  items: { path: string; match?: string[] }[],
) {
  if (pathname === "/")
    return items.find((i) => i.path === "/explorer")?.path ?? null;
  let best: string | null = null;
  let score = 0;
  for (const item of items)
    for (const prefix of item.match ?? [])
      if (matchesPrefix(pathname, prefix) && prefix.length > score) {
        best = item.path;
        score = prefix.length;
      }
  return best;
}

function ExplorerHeader() {
  const app = appById("explorer")!;
  const n = useNetwork();
  const { pathname } = useLocation();
  const items = app.localNavigation ?? [];
  const active = activeExplorerItem(pathname, items);
  return (
    <RougeAppShell
      product="Explorer"
      proposedHost=""
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={
        <Status state={n.state}>
          {n.state === "live" ? "Live API" : n.state} · {n.network.label}
        </Status>
      }
      globalNavigation={null}
      actions={
        <>
          <a className="docs-link" href={MAIN_SITE_URL}>
            rougechain.io <ArrowUpRight size={13} />
          </a>
          <a className="docs-link" href={DOCS_URL}>
            Docs <ArrowUpRight size={13} />
          </a>
        </>
      }
      localNavigation={
        <nav className="local-nav" aria-label="Explorer navigation">
          {items.map((item) => {
            const to = item.path === "/explorer" ? "/" : item.path;
            return (
              <Link
                key={item.path}
                to={to}
                className={active === item.path ? "active" : undefined}
                aria-current={active === item.path ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      }
    />
  );
}

function ExplorerFooter() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Link className="wordmark" to="/">
              <img src="/xrge-logo.webp" alt="" />
              RougeChain Explorer
            </Link>
            <p>Every block, transaction and address on RougeChain.</p>
          </div>
          <div className="footer-links">
            <TextLink href={MAIN_SITE_URL}>rougechain.io</TextLink>
            <TextLink href={DOCS_URL}>Documentation</TextLink>
            <TextLink href={SOURCE_URL}>GitHub</TextLink>
            <TextLink href="https://x.com/rougecoin">Community</TextLink>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} RougeChain</span>
          <span>Post-quantum from genesis.</span>
        </div>
      </div>
    </footer>
  );
}

export function ExplorerRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      {/* On explorer.rougechain.io there is no Bridge app, so /bridge is the bridge activity. */}
      <Route path="/bridge" element={<BridgeActivityPage />} />
      {explorerRoutes}
      <Route
        path="*"
        element={
          <main id="main" className="container page-intro">
            <h1>Page not found.</h1>
            <p>Search for a block, transaction, address, token or contract.</p>
            <Link className="button" to="/">
              Explorer home
            </Link>
          </main>
        }
      />
    </Routes>
  );
}

export default function ExplorerSite() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChainProvider>
        <NetworkProvider>
          <BrowserRouter>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <ExplorerHeader />
            <ExplorerRoutes />
            <ExplorerFooter />
          </BrowserRouter>
        </NetworkProvider>
      </ChainProvider>
    </QueryClientProvider>
  );
}
