import { useEffect, useState } from "react";
import { Dialog } from "@rougechain/ui";
import { toDataURL } from "qrcode";
import { CopyText } from "./parts";

/** QR image (data URL) of `value`, generated locally. */
export function useQr(value: string | null): string | null {
  const [qr, setQr] = useState<{ value: string; url: string } | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    toDataURL(value, { width: 220, margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => {
        if (!cancelled) setQr({ value, url });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value]);
  return value && qr?.value === value ? qr.url : null;
}

export function ReceiveDialog({
  open,
  onClose,
  address,
  publicKey,
  networkLabel,
}: {
  open: boolean;
  onClose: () => void;
  address: string | null;
  publicKey: string;
  networkLabel: string;
}) {
  const qr = useQr(open ? address : null);
  return (
    <Dialog open={open} onClose={onClose} title="Receive">
      <div className="receive-body">
        <div className="qr-frame">
          {qr ? <img src={qr} alt="QR code of your rouge1 address" width={220} height={220} /> : <span className="muted">Generating…</span>}
        </div>
        <p className="form-hint">Your {networkLabel} address. Share it to receive XRGE and RougeChain tokens.</p>
        {address && <CopyText value={address} label="address" />}
        <details className="pubkey-details">
          <summary>Public key (legacy senders)</summary>
          <CopyText value={publicKey} label="public key" display={`${publicKey.slice(0, 24)}…${publicKey.slice(-12)}`} />
        </details>
      </div>
    </Dialog>
  );
}
