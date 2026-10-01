import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { TOKEN_CREATION_FEE, type WalletBalance } from "@rougechain/core/pqc-wallet";
import { secureCreateToken } from "@rougechain/core/secure-api";
import { fileToLogoDataUri } from "@rougechain/core/image-utils";
import { useWallet } from "./WalletProvider";
import { useTokenMintingActive } from "./hooks";
import { TOKEN_MINT_MAX_AMOUNT, type TokenMintOptions } from "@rougechain/core/token-minting";
import { toast } from "./toast";
import i18n from "../i18n";

export interface TokenForm {
  name: string;
  symbol: string;
  supply: string;
  /** TOKEN_MINTING only (the fields are hidden — and ignored — while the upgrade is inactive). */
  mintable?: boolean;
  maxSupply?: string;
}

/** Validation used by the create-token form (same rules as apps/web's CreateTokenDialog). */
export function checkTokenForm(f: TokenForm, xrgeBalance: number): string | null {
  if (!f.name.trim()) return i18n.t("wallet:createToken.errors.nameRequired");
  if (!f.symbol.trim()) return i18n.t("wallet:createToken.errors.symbolRequired");
  if (f.symbol.trim().length > 10) return i18n.t("wallet:createToken.errors.symbolLength", { count: 10 });
  const supply = Number(f.supply);
  if (!/^\d+$/.test(f.supply.trim()) || !Number.isSafeInteger(supply) || supply <= 0) return i18n.t("wallet:createToken.errors.supply");
  if (f.mintable && f.maxSupply?.trim()) {
    const max = Number(f.maxSupply.trim());
    if (!/^\d+$/.test(f.maxSupply.trim()) || !Number.isSafeInteger(max) || max > TOKEN_MINT_MAX_AMOUNT || max < supply)
      return i18n.t("wallet:createToken.errors.maxSupply");
  }
  if (xrgeBalance < TOKEN_CREATION_FEE) return i18n.t("wallet:createToken.errors.insufficient", { fee: TOKEN_CREATION_FEE });
  return null;
}

/**
 * The mint options to sign for a (validated) form: none unless token minting is active and the
 * Mintable box is ticked, so a fixed-supply token's payload is exactly what it was before.
 */
export function tokenFormMintOptions(f: TokenForm, mintingActive: boolean): TokenMintOptions | undefined {
  if (!mintingActive || !f.mintable) return undefined;
  const max = f.maxSupply?.trim();
  return max ? { mintable: true, maxSupply: Number(max) } : { mintable: true };
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
  const { wallet, network } = useWallet();
  const mintingActive = useTokenMintingActive(network, open);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [mintable, setMintable] = useState(false);
  const [maxSupply, setMaxSupply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const xrge = balances.find((b) => b.symbol === "XRGE")?.balance ?? 0;

  const submit = async () => {
    const form: TokenForm = { name, symbol, supply, mintable: mintingActive && mintable, maxSupply };
    const problem = checkTokenForm(form, xrge);
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
        tokenFormMintOptions(form, mintingActive),
      );
      if (!r.success) throw new Error(r.error || t("createToken.errors.failed"));
      toast.success(t("createToken.created", { symbol: sym }), { description: t("createToken.createdBody") });
      setName("");
      setSymbol("");
      setSupply("");
      setDescription("");
      setImage("");
      setMintable(false);
      setMaxSupply("");
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
        {mintingActive && (
          <div className="field" data-testid="mint-options">
            <label className="check-row">
              <input type="checkbox" checked={mintable} onChange={(e) => setMintable(e.target.checked)} />
              <span>{t("createToken.mintable")}</span>
            </label>
            <p className="form-hint">{t("createToken.mintableHint")}</p>
            {mintable && (
              <label className="field">
                {t("createToken.maxSupply")}
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={maxSupply}
                  onChange={(e) => setMaxSupply(e.target.value)}
                  placeholder={t("createToken.maxSupplyPlaceholder")}
                />
              </label>
            )}
          </div>
        )}
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
