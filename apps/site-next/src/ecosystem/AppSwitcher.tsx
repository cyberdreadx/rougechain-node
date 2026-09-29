import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  globalApps,
  globalAppGroups,
  appHref,
  type EcosystemApp,
} from "./apps";
export function AppSwitcher({ current }: { current?: EcosystemApp }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("a")?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="app-switcher">
      <button
        ref={trigger}
        className="button ghost small"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        Apps <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="switcher-backdrop" onClick={close}>
          <div
            id={menuId}
            ref={panel}
            className="switcher-panel"
            role="dialog"
            aria-label="RougeChain apps"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
              if (e.key === "Tab") {
                const nodes =
                  panel.current?.querySelectorAll<HTMLElement>("a,button");
                if (nodes?.length) {
                  const first = nodes[0],
                    last = nodes[nodes.length - 1];
                  if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                  } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                  }
                }
              }
            }}
          >
            <div className="switcher-top">
              <Link to="/" onClick={close}>
                RougeChain home
              </Link>
              <button
                className="button ghost small"
                onClick={close}
                aria-label="Close apps"
              >
                Close ×
              </button>
            </div>
            {current?.localNavigation && (
              <nav
                className="switcher-local"
                aria-label={`${current.name} mobile navigation`}
              >
                <strong>{current.name}</strong>
                {current.localNavigation.map((n) => (
                  <Link key={n.path} to={n.path} onClick={close}>
                    {n.label}
                  </Link>
                ))}
              </nav>
            )}
            <div className="switcher-groups" aria-label="Global applications">
              {globalAppGroups.map((group) => (
                <section key={group}>
                  <h2>{group}</h2>
                  {globalApps
                    .filter((a) => a.group === group)
                    .map((a) =>
                      a.status === "future" ? (
                        <div
                          className="switcher-placeholder"
                          key={a.id}
                          aria-disabled="true"
                        >
                          <span>{a.name}</span>
                          <small>Coming soon</small>
                        </div>
                      ) : (
                        <Link
                          key={a.id}
                          to={appHref(a)}
                          aria-label={
                            a.id === "wallet-extension"
                              ? "RougeChain Wallet Extension ↗"
                              : undefined
                          }
                          onClick={close}
                          {...(a.externalUrl
                            ? { target: "_blank", rel: "noreferrer" }
                            : {})}
                        >
                          <span>
                            {a.name}
                            {a.externalUrl ? " ↗" : ""}
                          </span>
                          <small>
                            {a.status === "live"
                              ? "Live"
                              : a.status === "preview"
                                ? "Preview"
                                : a.status === "demo"
                                  ? "Demo"
                                  : a.status === "external"
                                    ? "External"
                                    : "Planned"}
                          </small>
                        </Link>
                      ),
                    )}
                </section>
              ))}
            </div>
            <div className="switcher-utilities">
              <Link to="/workspace" onClick={close}>
                Full workspace
              </Link>
              <Link to="/architecture" onClick={close}>
                Architecture
              </Link>
              <Link to="/design-system" onClick={close}>
                Design system
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
