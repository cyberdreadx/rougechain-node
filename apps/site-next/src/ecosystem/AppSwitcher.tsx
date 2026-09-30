import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  globalApps,
  globalAppGroups,
  appHref,
  type EcosystemApp,
} from "./apps";
export function AppSwitcher({ current }: { current?: EcosystemApp }) {
  const { t } = useTranslation("common");
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
        {t("switcher.apps")} <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="switcher-backdrop" onClick={close}>
          <div
            id={menuId}
            ref={panel}
            className="switcher-panel"
            role="dialog"
            aria-label={t("switcher.dialog")}
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
                {t("switcher.home")}
              </Link>
              <button
                className="button ghost small"
                onClick={close}
                aria-label={t("switcher.closeLabel")}
              >
                {t("switcher.close")} ×
              </button>
            </div>
            {current?.localNavigation && (
              <nav
                className="switcher-local"
                aria-label={t("switcher.localNav", {
                  name: t(`apps.${current.id}.name`),
                })}
              >
                <strong>{t(`apps.${current.id}.name`)}</strong>
                {current.localNavigation.map((n) => (
                  <Link key={n.path} to={n.path} onClick={close}>
                    {t(`appNav.${n.key}`)}
                  </Link>
                ))}
              </nav>
            )}
            <div className="switcher-groups" aria-label={t("switcher.global")}>
              {globalAppGroups.map((group) => (
                <section key={group}>
                  <h2>{t(`appGroups.${group}`)}</h2>
                  {globalApps
                    .filter((a) => a.group === group)
                    .map((a) =>
                      a.status === "future" ? (
                        <div
                          className="switcher-placeholder"
                          key={a.id}
                          aria-disabled="true"
                        >
                          <span>{t(`apps.${a.id}.name`)}</span>
                          <small>{t("switcher.comingSoon")}</small>
                        </div>
                      ) : (
                        <Link
                          key={a.id}
                          to={appHref(a)}
                          aria-label={
                            a.id === "wallet-extension"
                              ? t("switcher.extensionLabel")
                              : undefined
                          }
                          onClick={close}
                          {...(a.externalUrl
                            ? { target: "_blank", rel: "noreferrer" }
                            : {})}
                        >
                          <span>
                            {t(`apps.${a.id}.name`)}
                            {a.externalUrl ? " ↗" : ""}
                          </span>
                          <small>
                            {t(`appStatus.${a.status}`)}
                          </small>
                        </Link>
                      ),
                    )}
                </section>
              ))}
            </div>
            <div className="switcher-utilities">
              <Link to="/workspace" onClick={close}>
                {t("switcher.workspace")}
              </Link>
              <Link to="/architecture" onClick={close}>
                {t("footer.architecture")}
              </Link>
              <Link to="/design-system" onClick={close}>
                {t("footer.designSystem")}
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
