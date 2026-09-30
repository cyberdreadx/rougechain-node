import {
  ProjectNavigation,
  marketingSections,
} from "./ecosystem/ProjectNavigation";
import { WalletControl } from "./wallet/WalletControl";
import { NetworkStatus } from "./Network";
import { useTranslation } from "react-i18next";
import { AppSwitcher } from "./ecosystem/AppSwitcher";
import { DOCS_URL, SOURCE_URL, appById } from "./ecosystem/apps";
import { Link, NavLink, useLocation } from "react-router-dom";
import { matchesPrefix } from "./explorer/routes";
import { ArrowUpRight } from "lucide-react";
import { TextLink, RougeAppShell } from "@rougechain/ui";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";
export const DOCS = DOCS_URL;
export const GITHUB = SOURCE_URL;
export function MarketingHeader() {
  const { t } = useTranslation("common");
  return (
    <header className="header">
      <div className="container header-inner">
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
        <nav className="marketing-nav" aria-label={t("header.mainNav")}>
          {marketingSections.map((x) => (
            <a key={x} href={`/#${x}`}>
              {t(`sections.${x}`)}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <AppSwitcher />
          <a className="docs-link" href={DOCS}>
            {t("header.docs")} <ArrowUpRight size={13} />
          </a>
          <WalletControl />
          <ProjectNavigation />
        </div>
      </div>
    </header>
  );
}
/** The local-nav item whose `match` prefixes best fit the path (so detail pages light up their section). */
function activeLocalItem(
  pathname: string,
  items: { path: string; match?: string[] }[],
) {
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
export function AppHeader({ product }: { product: string }) {
  const { t } = useTranslation("common");
  const app = appById(product.toLowerCase())!;
  const name = t(`apps.${app.id}.name`);
  const { pathname } = useLocation();
  const active = activeLocalItem(pathname, app.localNavigation ?? []);
  return (
    <RougeAppShell
      product={name}
      proposedHost=""
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={<NetworkStatus />}
      globalNavigation={<AppSwitcher current={app} />}
      actions={
        <>
          <a className="docs-link" href={DOCS}>
            {t("header.docs")} ↗
          </a>
          <WalletControl />
          <ProjectNavigation />
        </>
      }
      localNavigation={
        <nav className="local-nav" aria-label={t("header.localNav", { name })}>
          {app.localNavigation?.map((item) =>
            item.match ? (
              <Link
                key={item.path}
                to={item.path}
                className={active === item.path ? "active" : undefined}
                aria-current={active === item.path ? "page" : undefined}
              >
                {t(`appNav.${item.key}`)}
              </Link>
            ) : (
              <NavLink end key={item.path} to={item.path}>
                {t(`appNav.${item.key}`)}
              </NavLink>
            ),
          )}
        </nav>
      }
    />
  );
}
export function WorkspaceHeader() {
  const { t } = useTranslation("common");
  return (
    <RougeAppShell
      product={t("header.workspace")}
      proposedHost=""
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={<NetworkStatus />}
      globalNavigation={<AppSwitcher />}
      actions={
        <>
          <a className="docs-link" href={DOCS}>
            {t("header.docs")} ↗
          </a>
          <WalletControl />
          <ProjectNavigation />
        </>
      }
      localNavigation={null}
    />
  );
}
export function Footer() {
  const { t } = useTranslation("common");
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Link className="wordmark" to="/">
              <img src="/xrge-logo.webp" alt="" />
              RougeChain
            </Link>
            <p>{t("footer.tagline")}</p>
          </div>
          <div className="footer-links">
            <TextLink href={DOCS}>{t("footer.docs")}</TextLink>
            <TextLink href={GITHUB}>GitHub</TextLink>
            <TextLink href="https://x.com/rougecoin">
              {t("footer.community")}
            </TextLink>
            <Link to="/design-system">{t("footer.designSystem")}</Link>
            <Link to="/architecture">{t("footer.architecture")}</Link>
            <Link to="/workspace">{t("header.workspace")}</Link>
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
