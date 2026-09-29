/** Profile editors (name, photo, mail name) on core's profile / avatar / mail-name modules. */
import { useEffect, useRef, useState } from "react";
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
      toast.error("Couldn't update your photo", { description: e instanceof Error ? e.message : undefined });
    } finally {
      notifyWalletChanged();
      setBusy(false);
    }
  };

  if (!wallet) return <p className="muted">Unlock or create a wallet to set a photo.</p>;
  return (
    <div className="avatar-editor">
      <Avatar uri={avatar} name={displayName} size={size} />
      <div className="actions">
        <Button variant="outline small" disabled={busy} onClick={() => file.current?.click()}>
          {avatar ? "Change photo" : "Upload photo"}
        </Button>
        <Button variant="ghost small" disabled={busy} onClick={() => setShowNfts((v) => !v)} aria-expanded={showNfts}>
          Choose NFT
        </Button>
        {avatar && (
          <Button variant="ghost small" disabled={busy} onClick={() => apply(null, "Profile photo removed")}>
            Remove
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
            await apply(await fileToAvatarDataUri(f), "Profile photo updated");
          } catch (err) {
            toast.error("Couldn't use that image", { description: err instanceof Error ? err.message : undefined });
          }
        }}
      />
      {showNfts && (
        <div className="nft-picker">
          {nfts === null ? (
            <p className="muted">Loading your NFTs…</p>
          ) : nfts.length === 0 ? (
            <p className="muted">No NFTs with an image in this wallet.</p>
          ) : (
            nfts.map((n) => (
              <button key={n.key} type="button" title={n.name} disabled={busy} onClick={() => apply(n.image, "Profile photo updated")}>
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
      toast.success("Display name updated");
    } catch (e) {
      toast.error("Couldn't update your name", { description: e instanceof Error ? e.message : undefined });
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
        Display name
      </label>
      <div className="field-row">
        <input id={id} className="input" value={name} maxLength={50} placeholder="Your name" onChange={(e) => setName(e.target.value)} disabled={!wallet} />
        <Button type="submit" variant="outline" disabled={!wallet || busy || !clean || clean === displayName}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** Claim or change your mail name (both @rouge.quant and @qwalla.mail addresses). */
export function MailNameEditor({ wallet, allowChange = true, onClaimed }: { wallet: UnifiedWallet | null; allowChange?: boolean; onClaimed?: (name: string) => void }) {
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
      toast.success(`Claimed ${a} and ${b}`);
      onClaimed?.(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't claim that name");
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) return <p className="muted">Unlock or create a wallet to claim a mail name.</p>;
  if (loading) return <p className="muted">Loading…</p>;
  if (current && !editing)
    return (
      <div className="mail-names">
        {mailAddresses(current).map((a) => (
          <CopyText key={a} value={a} label={a} />
        ))}
        {allowChange && (
          <Button variant="ghost small" onClick={() => setEditing(true)}>
            Change name
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
        Mail name
        <span className="field-row">
          <input className="input mono" value={input} placeholder="yourname" onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
        </span>
      </label>
      {clean && !invalid && (
        <p className="form-hint mono">
          {mailAddresses(clean)[0]} · {mailAddresses(clean)[1]}
        </p>
      )}
      <p className={`form-hint ${invalid ? "error" : ""}`}>3–20 letters, numbers or underscores (not at the start or end).</p>
      {current && <p className="form-hint">{current} will be released and anyone could claim it.</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        {current && (
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy || !clean || !!invalid}>
          {busy ? "Claiming…" : current ? "Save new name" : "Claim name"}
        </Button>
      </div>
    </form>
  );
}
