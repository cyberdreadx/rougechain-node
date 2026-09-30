import { useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Dialog } from "@rougechain/ui";
import { DOCS_URL } from "./apps";
import { useWalletIdentity } from "../wallet/WalletProvider";
import { useTranslation } from "react-i18next";
/** Homepage section anchors (#id); labels are common:sections.<id>. */
export const marketingSections = [
  "technology",
  "build",
  "security",
  "ecosystem",
  "regenerate",
  "explore",
];
export function ProjectNavigation() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wallet = useWalletIdentity();
  const { t } = useTranslation("common");
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <div className="project-navigation">
      <button
        className="button ghost icon"
        ref={trigger}
        aria-label={t("projectNav.label")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Menu size={18} />
      </button>
      <Dialog open={open} onClose={close} title={t("projectNav.title")}>
        <nav className="project-links" aria-label={t("projectNav.sections")}>
          {marketingSections.map((name) => (
            <a key={name} href={`/#${name}`} onClick={close}>
              {t(`sections.${name}`)}
            </a>
          ))}
          <a href={DOCS_URL}>{t("footer.docs")} ↗</a>
          <a href="/">{t("projectNav.home")}</a>
        </nav>
        <p className="wallet-disclaimer">
          {wallet.connected
            ? t("projectNav.walletConnected", { address: wallet.short })
            : t("projectNav.walletDisconnected")}
        </p>
      </Dialog>
    </div>
  );
}
