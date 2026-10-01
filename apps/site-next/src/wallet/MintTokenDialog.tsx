import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { secureMintTokens } from "@rougechain/core/secure-api";
import {
  TOKEN_MINT_FEE_XRGE,
  TOKEN_MINT_MAX_AMOUNT,
  canMintToken,
  mintRoom,
  type TokenMintInfo,
} from "@rougechain/core/token-minting";
import { useOptionalWallet } from "./WalletProvider";
import { useTokenMintingActive } from "./hooks";
import { toast } from "./toast";
import i18n from "../i18n";
import type { ExplorerTokenActionProps } from "../explorer/slots";

const fmt = (n: number) => n.toLocaleString(i18n.language);

/** Validate a mint amount against the room left under the cap (`null` room = unknown, node decides). */
export function checkMintAmount(amount: string, room: number | null): string | null {
  const v = amount.trim();
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n <= 0 || n > TOKEN_MINT_MAX_AMOUNT)
    return i18n.t("wallet:mintToken.errors.amount");
  if (room !== null && n > room) return i18n.t("wallet:mintToken.errors.exceedsCap", { room: fmt(room) });
  return null;
}

/**
 * "Mint" for a token's creator (node TOKEN_MINTING upgrade). Renders nothing unless a wallet is
 * unlocked on `network`, the upgrade is active there, the token is mintable and the wallet created it.
 */
export function TokenMintAction({
  token,
  network,
  onMinted,
}: {
  token: TokenMintInfo & { symbol: string };
  /** The network the token was read from; the wallet must be on the same one. */
  network: string;
  onMinted?: () => void;
}) {
  const w = useOptionalWallet();
  const eligible = !!w && w.status === "unlocked" && !!w.wallet && w.network === network && canMintToken(token, w.publicKey);
  const active = useTokenMintingActive(w?.network ?? network, eligible);
  if (!eligible || !active) return null;
  return <TokenMintButton token={token} onMinted={onMinted} />;
}

/** Explorer token page adapter (camelCase `TokenInfo` from @rougechain/chain-readonly). */
export function ExplorerTokenMintAction({ token, network, onChanged }: ExplorerTokenActionProps) {
  return (
    <TokenMintAction
      network={network}
      onMinted={onChanged}
      token={{
        symbol: token.symbol,
        creator: token.creator,
        mintable: token.mintable,
        max_supply: token.maxSupply,
        total_minted: token.totalMinted ?? 0,
        initial_supply: token.initialSupply,
      }}
    />
  );
}

function TokenMintButton({ token, onMinted }: { token: TokenMintInfo & { symbol: string }; onMinted?: () => void }) {
  const { t } = useTranslation("wallet");
  const [open, setOpen] = useState(false);
  const room = mintRoom(token);
  return (
    <>
      <div className="actions" data-testid="token-mint-action">
        <Button onClick={() => setOpen(true)} disabled={room === 0}>
          {t("mintToken.action")}
        </Button>
      </div>
      {room === 0 && <p className="form-hint">{t("mintToken.capReached", { symbol: token.symbol })}</p>}
      <MintTokenDialog open={open} onClose={() => setOpen(false)} token={token} onMinted={onMinted} />
    </>
  );
}

export function MintTokenDialog({
  open,
  onClose,
  token,
  onMinted,
}: {
  open: boolean;
  onClose: () => void;
  token: TokenMintInfo & { symbol: string };
  onMinted?: () => void;
}) {
  const { t } = useTranslation("wallet");
  const w = useOptionalWallet();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const room = mintRoom(token);
  const symbol = token.symbol;

  const submit = async () => {
    const problem = checkMintAmount(amount, room === Number.POSITIVE_INFINITY ? null : room);
    if (problem) return setError(problem);
    const wallet = w?.wallet;
    if (!wallet) return setError(t("send.errors.unlockFirst"));
    setBusy(true);
    setError("");
    try {
      const n = Number(amount.trim());
      // Signs locally, or through the extension / Qwalla provider when there is no local key.
      const r = await secureMintTokens(wallet.signingPublicKey, wallet.signingPrivateKey, symbol, n);
      if (!r.success) throw new Error(r.error || t("mintToken.errors.failed"));
      toast.success(t("mintToken.minted", { amount: fmt(n), symbol }), { description: t("mintToken.mintedBody") });
      setAmount("");
      onMinted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mintToken.errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={t("mintToken.title", { symbol })}>
      <form
        className="wallet-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          {t("mintToken.amount")}
          <input
            className="input mono"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
            autoFocus
          />
        </label>
        <p className="form-hint" data-testid="mint-room">
          {room === Number.POSITIVE_INFINITY
            ? t("mintToken.uncapped")
            : room === null
              ? t("mintToken.capOnly", { max: fmt(token.max_supply ?? 0), symbol })
              : t("mintToken.room", { amount: fmt(room), symbol, max: fmt(token.max_supply ?? 0) })}
        </p>
        <p className="form-hint">{t("mintToken.feeHint", { fee: TOKEN_MINT_FEE_XRGE })}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? t("send.signing") : t("mintToken.submit", { fee: TOKEN_MINT_FEE_XRGE })}
        </Button>
      </form>
    </Dialog>
  );
}
