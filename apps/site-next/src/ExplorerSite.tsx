import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { RougeAppShell, TextLink } from "@rougechain/ui";
import { useTranslation } from "react-i18next";
import { ChainProvider } from "./explorer/chain";
import { NetworkProvider, NetworkStatus } from "./Network";
import Overview from "./explorer/Overview";
import { explorerRoutes, matchesPrefix } from "./explorer/routes";
import { BridgeActivityPage } from "./explorer/Bridge";
import { DOCS_URL, SOURCE_URL, appById } from "./ecosystem/apps";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";
import { UiText } from "./i18n/UiText";

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
  const { t } = useTranslation("common");
  const app = appById("explorer")!;
  const { pathname } = useLocation();
  const items = app.localNavigation ?? [];
  const active = activeExplorerItem(pathname, items);
  return (
    <RougeAppShell
      product={t("apps.explorer.name")}
      proposedHost=""
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={<NetworkStatus />}
      globalNavigation={null}
      actions={
        <>
          <a className="docs-link" href={MAIN_SITE_URL}>
            rougechain.io <ArrowUpRight size={13} />
          </a>
          <a className="docs-link" href={DOCS_URL}>
            {t("header.docs")} <ArrowUpRight size={13} />
          </a>
        </>
      }
      localNavigation={
        <nav className="local-nav" aria-label={t("header.localNav", { name: t("apps.explorer.name") })}>
          {items.map((item) => {
            const to = item.path === "/explorer" ? "/" : item.path;
            return (
              <Link
                key={item.path}
                to={to}
                className={active === item.path ? "active" : undefined}
                aria-current={active === item.path ? "page" : undefined}
              >
                {t(`appNav.${item.key}`)}
              </Link>
            );
          })}
        </nav>
      }
    />
  );
}

function ExplorerFooter() {
  const { t } = useTranslation("common");
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Link className="wordmark" to="/">
              <img src="/xrge-logo.webp" alt="" />
              {t("explorerSite.wordmark")}
            </Link>
            <p>{t("explorerSite.tagline")}</p>
          </div>
          <div className="footer-links">
            <TextLink href={MAIN_SITE_URL}>rougechain.io</TextLink>
            <TextLink href={DOCS_URL}>{t("footer.docs")}</TextLink>
            <TextLink href={SOURCE_URL}>GitHub</TextLink>
            <TextLink href="https://x.com/rougecoin">
              {t("footer.community")}
            </TextLink>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} RougeChain</span>
          <LanguageSwitcher />
          <span>{t("footer.motto")}</span>
        </div>
      </div>
    </footer>
  );
}

export function ExplorerRoutes() {
  const { t } = useTranslation("common");
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
            <h1>{t("notFound.title")}</h1>
            <p>{t("notFound.explorerBody")}</p>
            <Link className="button" to="/">
              {t("notFound.explorerHome")}
            </Link>
          </main>
        }
      />
    </Routes>
  );
}

function SkipLink() {
  const { t } = useTranslation("common");
  return (
    <a className="skip" href="#main">
      {t("skipToContent")}
    </a>
  );
}

export default function ExplorerSite() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChainProvider>
        <NetworkProvider>
          <BrowserRouter>
            <UiText>
              <SkipLink />
              <ExplorerHeader />
              <ExplorerRoutes />
              <ExplorerFooter />
            </UiText>
          </BrowserRouter>
        </NetworkProvider>
      </ChainProvider>
    </QueryClientProvider>
  );
}
