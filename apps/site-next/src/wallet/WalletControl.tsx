import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Wallet } from "lucide-react";
import { Dialog, Button } from "@rougechain/ui";
import { formatPubkey } from "@rougechain/core/address";
import { getRougeChainProvider } from "@rougechain/core/extension-bridge";
import { useWallet } from "./WalletProvider";
import { useRougeAddress } from "./hooks";
import { CopyText, UnlockForm } from "./parts";
import { toast } from "./toast";

const NETWORK_LABEL = { mainnet: "Mainnet", testnet: "Testnet" } as const;

/** Header wallet control: connect / create / import / unlock / lock, address + copy, network. */
export function WalletControl() {
  const w = useWallet();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { full, display } = useRougeAddress(w.publicKey);
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  const go = (path: string) => {
    close();
    navigate(path);
  };

  const label =
    w.status === "unlocked" ? display || "Wallet" : w.status === "locked" ? "Locked" : "Connect Wallet";
  const compact = w.status === "unlocked" ? "Wallet" : w.status === "locked" ? "Locked" : "Connect";
  const ariaLabel =
    w.status === "unlocked"
      ? `Wallet ${full ?? display}`
      : w.status === "locked"
        ? "Wallet locked — unlock"
        : "Connect Wallet";

  const connectExtension = async () => {
    setBusy(true);
    try {
      await w.connectExtension();
      toast.success("Extension wallet connected");
      close();
    } catch (e) {
      toast.error("Couldn't connect the extension", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await w.create();
      go("/wallet");
    } catch (e) {
      toast.error("Couldn't create a wallet", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wallet-control">
      <button
        ref={trigger}
        className={`button outline small wallet-trigger ${w.status}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Wallet size={15} aria-hidden="true" />
        <span className="wallet-trigger-label">{label}</span>
        <span className="wallet-trigger-compact" aria-hidden="true">
          {compact}
        </span>
      </button>

      {w.status === "none" && (
        <Dialog open={open} onClose={close} title="Connect to RougeChain">
          <p className="muted">A post-quantum wallet in this browser, or the RougeChain extension.</p>
          <div className="provider-options">
            <button className="provider-option" onClick={create} disabled={busy}>
              <span>
                <strong>Create a new wallet</strong>
                <small>ML-DSA-65 keys from a 24-word recovery phrase</small>
              </span>
              <span>Create →</span>
            </button>
            <button className="provider-option" onClick={() => go("/wallet?import=1")} disabled={busy}>
              <span>
                <strong>Import a wallet</strong>
                <small>Recovery phrase or .pqcbackup file</small>
              </span>
              <span>Import →</span>
            </button>
            <button className="provider-option" onClick={connectExtension} disabled={busy}>
              <span>
                <strong>RougeChain Wallet</strong>
                <small>{getRougeChainProvider() ? "Extension detected" : "Browser extension · not detected"}</small>
              </span>
              <span>Connect →</span>
            </button>
          </div>
          <p className="wallet-disclaimer">Keys are generated and kept in this browser. They are never sent to a server.</p>
        </Dialog>
      )}

      {w.status === "locked" && (
        <Dialog open={open} onClose={close} title="Unlock wallet">
          <div className="account-identity">
            <strong>{w.displayName || "Your wallet"}</strong>
            <span>{NETWORK_LABEL[w.network]} · locked</span>
            {w.publicKey && <small className="mono">{formatPubkey(w.publicKey, 12, 6)}</small>}
          </div>
          <UnlockForm onUnlocked={close} />
        </Dialog>
      )}

      {w.status === "unlocked" && (
        <Dialog open={open} onClose={close} title="Your wallet">
          <div className="account-identity">
            <strong>{w.displayName || "My Wallet"}</strong>
            <span>
              {NETWORK_LABEL[w.network]} · {w.isExtension ? "RougeChain extension" : "This browser"}
            </span>
          </div>
          {full ? <CopyText value={full} label="address" /> : <small className="muted">Deriving address…</small>}
          <div className="account-actions">
            <Link className="button" to="/wallet" onClick={close}>
              Open Wallet
            </Link>
            <Link className="button outline" to="/settings" onClick={close}>
              Settings
            </Link>
            {full && (
              <Link className="button ghost" to={`/address/${full}`} onClick={close}>
                View in Explorer
              </Link>
            )}
          </div>
          <div className="account-disconnect">
            {w.hasPassword ? (
              <Button
                variant="outline"
                onClick={() => {
                  w.lock();
                  toast.info("Wallet locked");
                  close();
                }}
              >
                Lock
              </Button>
            ) : (
              <Link className="text-link" to="/settings#security" onClick={close}>
                Set a password to enable lock
              </Link>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
