import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { TOKEN_CREATION_FEE, type WalletBalance } from "@rougechain/core/pqc-wallet";
import { secureCreateToken } from "@rougechain/core/secure-api";
import { fileToLogoDataUri } from "@rougechain/core/image-utils";
import { useWallet } from "./WalletProvider";
import { toast } from "./toast";
import i18n from "../i18n";

/** Validation used by the create-token form (same rules as apps/web's CreateTokenDialog). */
export function checkTokenForm(f: { name: string; symbol: string; supply: string }, xrgeBalance: number): string | null {
  if (!f.name.trim()) return i18n.t("wallet:createToken.errors.nameRequired");
  if (!f.symbol.trim()) return i18n.t("wallet:createToken.errors.symbolRequired");
  if (f.symbol.trim().length > 10) return i18n.t("wallet:createToken.errors.symbolLength", { count: 10 });
  const supply = Number(f.supply);
  if (!/^\d+$/.test(f.supply.trim()) || !Number.isSafeInteger(supply) || supply <= 0) return i18n.t("wallet:createToken.errors.supply");
  if (xrgeBalance < TOKEN_CREATION_FEE) return i18n.t("wallet:createToken.errors.insufficient", { fee: TOKEN_CREATION_FEE });
  return null;
}

export function CreateTokenDialog({
  open,
  onClose,
  balances,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  balances: WalletBalance[];
  onCreated: () => void;
}) {
  const { t } = useTranslation("wallet");
  const { wallet } = useWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const xrge = balances.find((b) => b.symbol === "XRGE")?.balance ?? 0;

  const submit = async () => {
    const problem = checkTokenForm({ name, symbol, supply }, xrge);
    if (problem) return setError(problem);
    if (!wallet) return setError(t("send.errors.unlockFirst"));
    setBusy(true);
    setError("");
    try {
      const sym = symbol.trim().toUpperCase();
      const r = await secureCreateToken(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        name.trim(),
        sym,
        Number(supply),
        TOKEN_CREATION_FEE,
        image.trim() || undefined,
        description.trim() || undefined,
      );
      if (!r.success) throw new Error(r.error || t("createToken.errors.failed"));
      toast.success(t("createToken.created", { symbol: sym }), { description: t("createToken.createdBody") });
      setName("");
      setSymbol("");
      setSupply("");
      setDescription("");
      setImage("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("createToken.errors.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={t("createToken.title")}>
      <form
        className="wallet-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          {t("createToken.name")}
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("createToken.namePlaceholder")} />
        </label>
        <div className="two-fields">
          <label className="field">
            {t("createToken.symbol")}
            <input className="input mono" value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="MAT" />
          </label>
          <label className="field">
            {t("createToken.supply")}
            <input className="input mono" inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="1000000" />
          </label>
        </div>
        <label className="field">
          {t("createToken.description")}
          <textarea className="input" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          {t("createToken.logo")}
          <span className="field-row">
            <input className="input" value={image.startsWith("data:") ? t("createToken.uploaded") : image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" readOnly={image.startsWith("data:")} />
            <Button type="button" variant="outline small" onClick={() => file.current?.click()}>
              {t("createToken.upload")}
            </Button>
            {image && (
              <Button type="button" variant="ghost small" onClick={() => setImage("")}>
                {t("createToken.clear")}
              </Button>
            )}
          </span>
        </label>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              setImage(await fileToLogoDataUri(f));
            } catch (err) {
              toast.error(t("profile.imageFailed"), { description: err instanceof Error ? err.message : undefined });
            }
          }}
        />
        <p className="form-hint">
          {t("createToken.feeHint", { fee: TOKEN_CREATION_FEE, balance: xrge.toLocaleString() })}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? t("send.signing") : t("createToken.submit", { fee: TOKEN_CREATION_FEE })}
        </Button>
      </form>
    </Dialog>
  );
}
