import { useRef, useState } from "react";
import { Dialog, Button } from "@rougechain/ui";
import { TOKEN_CREATION_FEE, type WalletBalance } from "@rougechain/core/pqc-wallet";
import { secureCreateToken } from "@rougechain/core/secure-api";
import { fileToLogoDataUri } from "@rougechain/core/image-utils";
import { useWallet } from "./WalletProvider";
import { toast } from "./toast";

/** Validation used by the create-token form (same rules as apps/web's CreateTokenDialog). */
export function checkTokenForm(f: { name: string; symbol: string; supply: string }, xrgeBalance: number): string | null {
  if (!f.name.trim()) return "Token name is required";
  if (!f.symbol.trim()) return "Token symbol is required";
  if (f.symbol.trim().length > 10) return "Symbol must be 10 characters or less";
  const supply = Number(f.supply);
  if (!/^\d+$/.test(f.supply.trim()) || !Number.isSafeInteger(supply) || supply <= 0) return "Total supply must be a whole number above zero";
  if (xrgeBalance < TOKEN_CREATION_FEE) return `Insufficient XRGE. Creating a token costs ${TOKEN_CREATION_FEE} XRGE`;
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
    if (!wallet) return setError("Unlock your wallet first");
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
      if (!r.success) throw new Error(r.error || "Token creation failed");
      toast.success(`Token ${sym} created`, { description: "It appears in your wallet after the next block." });
      setName("");
      setSymbol("");
      setSupply("");
      setDescription("");
      setImage("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="Create a token">
      <form
        className="wallet-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          Token name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Awesome Token" />
        </label>
        <div className="two-fields">
          <label className="field">
            Symbol
            <input className="input mono" value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="MAT" />
          </label>
          <label className="field">
            Total supply
            <input className="input mono" inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="1000000" />
          </label>
        </div>
        <label className="field">
          Description (optional)
          <textarea className="input" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          Logo URL or upload (optional)
          <span className="field-row">
            <input className="input" value={image.startsWith("data:") ? "Uploaded image" : image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" readOnly={image.startsWith("data:")} />
            <Button type="button" variant="outline small" onClick={() => file.current?.click()}>
              Upload
            </Button>
            {image && (
              <Button type="button" variant="ghost small" onClick={() => setImage("")}>
                Clear
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
              toast.error("Couldn't use that image", { description: err instanceof Error ? err.message : undefined });
            }
          }}
        />
        <p className="form-hint">
          Fee {TOKEN_CREATION_FEE} XRGE · you have {xrge.toLocaleString()} XRGE. The whole supply goes to your wallet.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Signing…" : `Create token (${TOKEN_CREATION_FEE} XRGE)`}
        </Button>
      </form>
    </Dialog>
  );
}
