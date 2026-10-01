/** Profile editors (name, photo, mail name) on core's profile / avatar / mail-name modules. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@rougechain/ui";
import { avatarInitials, fitsAvatarLimit, isSafeAvatarUrl } from "@rougechain/core/avatar";
import { fileToAvatarDataUri } from "@rougechain/core/avatar-image";
import { claimMailName, getMyMailName, mailAddresses, mailNameError, normalizeMailName } from "@rougechain/core/mail-name";
import { getProfileAvatar, setProfileAvatar, setProfileDisplayName } from "@rougechain/core/profile";
import { getNftsByOwner, type NftToken } from "@rougechain/core/secure-api";
import type { UnifiedWallet } from "@rougechain/core/unified-wallet";
import { notifyWalletChanged } from "./store";
import { useWallet } from "./WalletProvider";
import { CopyText } from "./parts";
import { toast } from "./toast";

export function Avatar({ uri, name, size = 64 }: { uri?: string; name?: string | null; size?: number }) {
  const style = { width: size, height: size };
  if (uri && isSafeAvatarUrl(uri)) return <img className="avatar" style={style} src={uri} alt="" referrerPolicy="no-referrer" />;
  return (
    <span className="avatar placeholder" style={{ ...style, fontSize: size / 2.6 }} aria-hidden="true">
      {avatarInitials(name)}
    </span>
  );
}

function ipfsToHttps(uri: string): string {
  return uri.startsWith("ipfs://") ? uri.replace("ipfs://", "https://ipfs.io/ipfs/") : uri;
}

/** Best-effort NFT image (metadata JSON `image`, else the metadata URI) — as apps/web's AvatarEditor. */
async function resolveNftImage(token: NftToken): Promise<string | undefined> {
  const raw = token.metadata_uri?.trim();
  if (!raw) return undefined;
  const uri = ipfsToHttps(raw);
  let image: string | undefined = uri;
  if (/^data:application\/json/i.test(uri) || /\.json(\?|#|$)/i.test(uri)) {
    try {
      const json = await (await fetch(uri)).json();
      image = typeof json?.image === "string" ? ipfsToHttps(json.image) : undefined;
    } catch {
      image = undefined;
    }
  }
  return isSafeAvatarUrl(image) && fitsAvatarLimit(image) ? image : undefined;
}

/** Upload (square crop, JPEG under 256 KB), pick an owned NFT, or remove your profile photo. */
export function AvatarEditor({ size = 88 }: { size?: number }) {
  const { t } = useTranslation("wallet");
  const { wallet, displayName, publicKey } = useWallet();
  const avatar = getProfileAvatar(wallet);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [nfts, setNfts] = useState<Array<{ key: string; name: string; image: string }> | null>(null);
  const [showNfts, setShowNfts] = useState(false);

  useEffect(() => {
    if (!showNfts || nfts !== null || !publicKey) return;
    let cancelled = false;
    (async () => {
      const res = await getNftsByOwner(publicKey);
      const tokens = res.success && Array.isArray(res.data) ? res.data.slice(0, 60) : [];
      const resolved = await Promise.all(
        tokens.map(async (tk) => {
          const image = await resolveNftImage(tk);
          return image ? { key: `${tk.collection_id}-${tk.token_id}`, name: tk.name || `#${tk.token_id}`, image } : null;
        }),
      );
      if (!cancelled) setNfts(resolved.filter((x): x is { key: string; name: string; image: string } => !!x));
    })().catch(() => {
      if (!cancelled) setNfts([]);
    });
    return () => {
      cancelled = true;
    };
  }, [showNfts, nfts, publicKey]);

  const apply = async (url: string | null, message: string) => {
    setBusy(true);
    try {
      await setProfileAvatar(url);
      toast.success(message);
    } catch (e) {
      toast.error(t("profile.photoFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      notifyWalletChanged();
      setBusy(false);
    }
  };

  if (!wallet) return <p className="muted">{t("profile.photoNoWallet")}</p>;
  return (
    <div className="avatar-editor">
      <Avatar uri={avatar} name={displayName} size={size} />
      <div className="actions">
        <Button variant="outline small" disabled={busy} onClick={() => file.current?.click()}>
          {avatar ? t("profile.changePhoto") : t("profile.uploadPhoto")}
        </Button>
        <Button variant="ghost small" disabled={busy} onClick={() => setShowNfts((v) => !v)} aria-expanded={showNfts}>
          {t("profile.chooseNft")}
        </Button>
        {avatar && (
          <Button variant="ghost small" disabled={busy} onClick={() => apply(null, t("profile.photoRemoved"))}>
            {t("profile.remove")}
          </Button>
        )}
      </div>
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
            await apply(await fileToAvatarDataUri(f), t("profile.photoUpdated"));
          } catch (err) {
            toast.error(t("profile.imageFailed"), { description: err instanceof Error ? err.message : undefined });
          }
        }}
      />
      {showNfts && (
        <div className="nft-picker">
          {nfts === null ? (
            <p className="muted">{t("profile.loadingNfts")}</p>
          ) : nfts.length === 0 ? (
            <p className="muted">{t("profile.noNfts")}</p>
          ) : (
            nfts.map((n) => (
              <button key={n.key} type="button" title={n.name} disabled={busy} onClick={() => apply(n.image, t("profile.photoUpdated"))}>
                <img src={n.image} alt={n.name} referrerPolicy="no-referrer" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function NameEditor({ id = "profile-name" }: { id?: string }) {
  const { t } = useTranslation("wallet");
  const { wallet, displayName } = useWallet();
  const [name, setName] = useState(displayName ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(displayName ?? ""), [displayName]);
  const clean = name.trim();
  const save = async () => {
    if (!clean || clean === displayName) return;
    setBusy(true);
    try {
      await setProfileDisplayName(clean);
      toast.success(t("profile.nameUpdated"));
    } catch (e) {
      toast.error(t("profile.nameFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      notifyWalletChanged();
      setBusy(false);
    }
  };
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field" htmlFor={id}>
        {t("profile.displayName")}
      </label>
      <div className="field-row">
        <input id={id} className="input" value={name} maxLength={50} placeholder={t("profile.namePlaceholder")} onChange={(e) => setName(e.target.value)} disabled={!wallet} />
        <Button type="submit" variant="outline" disabled={!wallet || busy || !clean || clean === displayName}>
          {busy ? t("profile.saving") : t("profile.save")}
        </Button>
      </div>
    </form>
  );
}

/** Claim or change your mail name (both @rouge.quant and @qwalla.mail addresses). */
export function MailNameEditor({ wallet, allowChange = true, onClaimed }: { wallet: UnifiedWallet | null; allowChange?: boolean; onClaimed?: (name: string) => void }) {
  const { t } = useTranslation("wallet");
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!wallet);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = wallet?.signingPublicKey;
  const claimedRef = useRef(onClaimed);
  useEffect(() => {
    claimedRef.current = onClaimed;
  });
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  });

  useEffect(() => {
    const w = walletRef.current;
    if (!w) return;
    let cancelled = false;
    getMyMailName(w)
      .then((n) => {
        if (cancelled) return;
        setCurrent(n);
        if (n) claimedRef.current?.(n);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-query only when the identity (signing key) changes.
  }, [key]);

  const clean = normalizeMailName(input);
  const invalid = clean ? mailNameError(clean) : null;
  const submit = async () => {
    if (!wallet || !clean || invalid || busy) return;
    setBusy(true);
    setError("");
    try {
      const name = await claimMailName(wallet, clean, current);
      setCurrent(name);
      setEditing(false);
      setInput("");
      const [a, b] = mailAddresses(name);
      toast.success(t("mailName.claimed", { a, b }));
      onClaimed?.(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mailName.claimFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) return <p className="muted">{t("mailName.noWallet")}</p>;
  if (loading) return <p className="muted">{t("loading")}</p>;
  if (current && !editing)
    return (
      <div className="mail-names">
        {mailAddresses(current).map((a) => (
          <CopyText key={a} value={a} label={a} />
        ))}
        {allowChange && (
          <Button variant="ghost small" onClick={() => setEditing(true)}>
            {t("mailName.change")}
          </Button>
        )}
      </div>
    );
  return (
    <form
      className="wallet-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        {t("mailName.label")}
        <span className="field-row">
          <input className="input mono" value={input} placeholder={t("mailName.placeholder")} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
        </span>
      </label>
      {clean && !invalid && (
        <p className="form-hint mono">
          {mailAddresses(clean)[0]} · {mailAddresses(clean)[1]}
        </p>
      )}
      <p className={`form-hint ${invalid ? "error" : ""}`}>{t("mailName.rules")}</p>
      {current && <p className="form-hint">{t("mailName.release", { name: current })}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        {current && (
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            {t("mailName.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={busy || !clean || !!invalid}>
          {busy ? t("mailName.claiming") : current ? t("mailName.saveNew") : t("mailName.claim")}
        </Button>
      </div>
    </form>
  );
}
