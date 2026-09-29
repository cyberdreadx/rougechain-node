import {
  ProjectNavigation,
  marketingSections,
} from "./ecosystem/ProjectNavigation";
import { WalletControl } from "./wallet/WalletControl";
import { useNetwork } from "./Network";
import { AppSwitcher } from "./ecosystem/AppSwitcher";
import { DOCS_URL, SOURCE_URL, appById } from "./ecosystem/apps";
import { Link, NavLink } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { DemoBadge, TextLink, RougeAppShell, Status } from "@rougechain/ui";
export const DOCS = DOCS_URL;
export const GITHUB = SOURCE_URL;
export function MarketingHeader() {
  return (
    <header className="header">
      <div className="container header-inner">
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
        <nav className="marketing-nav" aria-label="Main navigation">
          {marketingSections.map((x) => (
            <a key={x} href={`/#${x.toLowerCase()}`}>
              {x}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <AppSwitcher />
          <a className="docs-link" href={DOCS}>
            Docs <ArrowUpRight size={13} />
          </a>
          <WalletControl />
          <ProjectNavigation />
        </div>
      </div>
    </header>
  );
}
export function AppHeader({ product }: { product: string }) {
  const app = appById(product.toLowerCase())!;
  const n = useNetwork();
  return (
    <RougeAppShell
      product={app.name}
      proposedHost={app.proposedHost}
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={
        <Status state={n.state}>
          {n.state === "live" ? "Live API" : n.state} · Mainnet
        </Status>
      }
      globalNavigation={<AppSwitcher current={app} />}
      actions={
        <>
          <a className="docs-link" href={DOCS}>
            Docs ↗
          </a>
          <WalletControl />
          <ProjectNavigation />
        </>
      }
      localNavigation={
        <nav className="local-nav" aria-label={`${app.name} navigation`}>
          {app.localNavigation?.map((item) => (
            <NavLink end key={item.path} to={item.path}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      }
    />
  );
}
export function WorkspaceHeader() {
  const n = useNetwork();
  return (
    <RougeAppShell
      product="Workspace"
      proposedHost=""
      brand={
        <Link className="wordmark" to="/">
          <img src="/xrge-logo.webp" alt="" />
          RougeChain
        </Link>
      }
      network={
        <Status state={n.state}>
          {n.state === "live" ? "Live API" : n.state} · Mainnet
        </Status>
      }
      globalNavigation={<AppSwitcher />}
      actions={
        <>
          <a className="docs-link" href={DOCS}>
            Docs ↗
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
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Link className="wordmark" to="/">
              <img src="/xrge-logo.webp" alt="" />
              RougeChain
            </Link>
            <p>Built for what comes next.</p>
          </div>
          <div className="footer-links">
            <TextLink href={DOCS}>Documentation</TextLink>
            <TextLink href={GITHUB}>GitHub</TextLink>
            <TextLink href="https://x.com/rougecoin">Community</TextLink>
            <Link to="/design-system">Design system</Link>
            <Link to="/architecture">Architecture</Link>
            <Link to="/workspace">Workspace</Link>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} RougeChain</span>
          <DemoBadge />
          <span>Post-quantum from genesis.</span>
        </div>
      </div>
    </footer>
  );
}
