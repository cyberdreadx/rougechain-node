import { useEffect, useState } from "react";
import { Dialog } from "@rougechain/ui";
import { toDataURL } from "qrcode";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("wallet");
  const qr = useQr(open ? address : null);
  return (
    <Dialog open={open} onClose={onClose} title={t("receive.title")}>
      <div className="receive-body">
        <div className="qr-frame">
          {qr ? <img src={qr} alt={t("receive.qrAlt")} width={220} height={220} /> : <span className="muted">{t("receive.generating")}</span>}
        </div>
        <p className="form-hint">{t("receive.hint", { network: networkLabel })}</p>
        {address && <CopyText value={address} label={t("copy.address")} />}
        <details className="pubkey-details">
          <summary>{t("receive.publicKey")}</summary>
          <CopyText value={publicKey} label={t("copy.publicKey")} display={`${publicKey.slice(0, 24)}…${publicKey.slice(-12)}`} />
        </details>
      </div>
    </Dialog>
  );
}
