import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet } from "lucide-react";
import { Dialog, Button } from "@rougechain/ui";
import {
  useDemoWallet,
  DEMO_SHORT_ADDRESS,
  type DemoSource,
} from "./DemoWalletProvider";
export function ConnectWalletDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const wallet = useDemoWallet();
  return (
    <Dialog open={open} onClose={onClose} title="Connect to RougeChain">
      <p className="muted">Preview one identity across the ecosystem.</p>
      <div className="provider-options">
        {(
          [
            {
              source: "extension",
              name: "RougeChain Wallet",
              description: "Browser extension",
            },
            {
              source: "qwalla",
              name: "Qwalla",
              description: "Mobile / dApp browser",
            },
          ] as const
        ).map((provider) => (
          <button
            key={provider.source}
            className="provider-option"
            onClick={() => {
              wallet.connectDemo(provider.source as DemoSource);
              onClose();
            }}
            aria-label={`Preview connection with ${provider.name}`}
          >
            <span>
              <strong>{provider.name}</strong>
              <small>{provider.description}</small>
            </span>
            <span>Preview connection ↗</span>
          </button>
        ))}
      </div>
      <p className="wallet-disclaimer">
        Design demonstration only. No wallet connection or signing is performed.
      </p>
    </Dialog>
  );
}
export function ConnectedAccountMenu({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const wallet = useDemoWallet();
  const [copied, setCopied] = useState(""),
    [explorer, setExplorer] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="Demo account">
      <div className="account-identity">
        <strong>{DEMO_SHORT_ADDRESS}</strong>
        <span>
          Mainnet ·{" "}
          {wallet.source === "qwalla" ? "Qwalla" : "RougeChain Wallet"}
        </span>
        <small>Synthetic identity · no account data</small>
      </div>
      <div className="account-actions">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(wallet.address ?? "");
              setCopied("Synthetic address copied");
            } catch {
              setCopied("Clipboard unavailable. Select the address below.");
            }
          }}
        >
          Copy address
        </Button>
        <Link
          className="button outline"
          to="/workspace?open=wallet"
          onClick={onClose}
        >
          Open Wallet
        </Link>
        <Button variant="ghost" onClick={() => setExplorer(true)}>
          View in Explorer
        </Button>
      </div>
      {copied && <p role="status">{copied}</p>}
      <code className="demo-full-address">{wallet.address}</code>
      {explorer && (
        <p role="status">
          Explorer address view not implemented in POC. This synthetic address
          is not queried on-chain.
        </p>
      )}
      <div className="account-disconnect">
        <Button
          variant="ghost"
          onClick={() => {
            wallet.disconnectDemo();
            onClose();
          }}
        >
          Disconnect
        </Button>
      </div>
      <p className="wallet-disclaimer">
        Demo connection only. No provider permissions, keys or signing.
      </p>
    </Dialog>
  );
}
export function WalletControl() {
  const wallet = useDemoWallet();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <div className="wallet-control">
      <button
        ref={trigger}
        className="button outline small wallet-trigger"
        aria-label={
          wallet.connected
            ? `Demo connected account ${DEMO_SHORT_ADDRESS}`
            : "Connect Wallet"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Wallet size={15} aria-hidden="true" />
        <span className="wallet-trigger-label">
          {wallet.connected ? `Demo · ${DEMO_SHORT_ADDRESS}` : "Connect Wallet"}
        </span>
        <span className="wallet-trigger-compact" aria-hidden="true">
          {wallet.connected ? "Demo" : "Connect"}
        </span>
      </button>
      {wallet.connected ? (
        <ConnectedAccountMenu open={open} onClose={close} />
      ) : (
        <ConnectWalletDialog open={open} onClose={close} />
      )}
    </div>
  );
}
