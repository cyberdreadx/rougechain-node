import { useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Dialog } from "@rougechain/ui";
import { DOCS_URL } from "./apps";
import {
  useDemoWallet,
  DEMO_SHORT_ADDRESS,
} from "../wallet/DemoWalletProvider";
export const marketingSections = [
  "Technology",
  "Explore",
  "Build",
  "Ecosystem",
  "Security",
  "Community",
];
export function ProjectNavigation() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wallet = useDemoWallet();
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <div className="project-navigation">
      <button
        className="button ghost icon"
        ref={trigger}
        aria-label="Project navigation"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Menu size={18} />
      </button>
      <Dialog open={open} onClose={close} title="Explore RougeChain">
        <nav className="project-links" aria-label="Project sections">
          {marketingSections.map((name) => (
            <a key={name} href={`/#${name.toLowerCase()}`} onClick={close}>
              {name}
            </a>
          ))}
          <a href={DOCS_URL}>Documentation ↗</a>
          <a href="/">RougeChain Home</a>
        </nav>
        <p className="wallet-disclaimer">
          {wallet.connected
            ? `Demo connected · ${DEMO_SHORT_ADDRESS}`
            : "Wallet disconnected · use Connect Wallet in the header."}
        </p>
      </Dialog>
    </div>
  );
}
