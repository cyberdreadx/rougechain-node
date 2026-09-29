import { useEffect, useState } from "react";
import { AtSign, CheckCircle2, Copy, Loader2, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAIL_DOMAIN, MAIL_DOMAIN_ALT } from "@/lib/pqc-mail";
import { claimMailName, getMyMailName, mailAddresses, mailNameError, normalizeMailName } from "@/lib/mail-name";
import type { UnifiedWallet } from "@/lib/unified-wallet";

interface MailNameEditorProps {
  wallet: UnifiedWallet | null;
  /** Called with the claimed name (or the existing one when it loads). */
  onClaimed?: (name: string) => void;
  /** Hide the "change" affordance (onboarding only claims). */
  allowChange?: boolean;
}

/** Claim or change your mail name; shows both @rouge.quant and @qwalla.mail addresses. */
export function MailNameEditor({ wallet, onClaimed, allowChange = true }: MailNameEditorProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!wallet) { setLoading(false); return; }
    setLoading(true);
    getMyMailName(wallet)
      .then((n) => {
        if (cancelled) return;
        setCurrent(n);
        if (n) onClaimed?.(n);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.signingPublicKey]);

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
      toast.success(t("profile.mail.claimed", { a: `${name}@${MAIL_DOMAIN}`, b: `${name}@${MAIL_DOMAIN_ALT}` }));
      onClaimed?.(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("profile.mail.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
      </div>
    );
  }

  if (current && !editing) {
    return (
      <div className="space-y-2">
        {mailAddresses(current).map((addr) => (
          <div key={addr} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
            <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            <span className="font-mono text-sm truncate flex-1">{addr}</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title={t("common.copy")}
              onClick={() => { navigator.clipboard?.writeText(addr).then(() => toast.success(t("common.copied"))).catch(() => {}); }}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        {allowChange && (
          <Button size="sm" variant="outline" onClick={() => { setEditing(true); setInput(current); }}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> {t("profile.mail.change")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("profile.mail.placeholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          className="cyber-input pl-9"
          disabled={!wallet}
        />
      </div>
      {clean && !invalid && (
        <div className="text-xs font-mono text-muted-foreground space-y-0.5">
          {mailAddresses(clean).map((addr) => (
            <p key={addr}>
              <span className="text-foreground">{clean}</span>
              <span className="text-primary">{addr.slice(clean.length)}</span>
            </p>
          ))}
        </div>
      )}
      {invalid && <p className="text-xs text-muted-foreground">{t("profile.mail.rules")}</p>}
      {current && editing && <p className="text-xs text-warning">{t("profile.mail.changeWarning", { name: current })}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!wallet || !clean || !!invalid || busy}>
          {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <AtSign className="w-4 h-4 mr-1.5" />}
          {current ? t("profile.mail.save") : t("profile.mail.claim")}
        </Button>
        {editing && (
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(""); }} disabled={busy}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default MailNameEditor;
