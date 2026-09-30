import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { encryptWallet } from "@rougechain/core/unified-wallet";
import { useWallet } from "./WalletProvider";
import { CopyText } from "./parts";
import { toast } from "./toast";

type Tab = "phrase" | "export" | "import";

/** Word grid for a recovery phrase (shown only on explicit reveal). */
export function PhraseGrid({ phrase }: { phrase: string }) {
  return (
    <ol className="phrase-grid">
      {phrase.split(" ").map((w, i) => (
        <li key={i}>
          <span>{i + 1}</span>
          <code>{w}</code>
        </li>
      ))}
    </ol>
  );
}

function download(data: string, fileName: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 3000);
    return true;
  } catch {
    return false;
  }
}

/** Import from a recovery phrase or an encrypted .pqcbackup (apps/web's WalletBackup import logic via core). */
export function ImportForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation("wallet");
  const { importMnemonic, importBackup } = useWallet();
  const [mode, setMode] = useState<"phrase" | "backup">("phrase");
  const [phrase, setPhrase] = useState("");
  const [data, setData] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "phrase") await importMnemonic(phrase);
      else await importBackup(data, password);
      setPhrase("");
      setData("");
      setPassword("");
      toast.success(mode === "phrase" ? t("import.recovered") : t("import.imported"));
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("import.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="wallet-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mode-switch" role="group" aria-label={t("import.from")}>
        <Button type="button" variant={mode === "phrase" ? "secondary small" : "ghost small"} aria-pressed={mode === "phrase"} onClick={() => setMode("phrase")}>
          {t("import.phrase")}
        </Button>
        <Button type="button" variant={mode === "backup" ? "secondary small" : "ghost small"} aria-pressed={mode === "backup"} onClick={() => setMode("backup")}>
          {t("import.file")}
        </Button>
      </div>
      {mode === "phrase" ? (
        <label className="field">
          {t("import.words")}
          <textarea className="input mono" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      ) : (
        <>
          <label className="field">
            {t("import.backupFile")}
            <input
              className="input"
              type="file"
              accept=".pqcbackup,application/octet-stream,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setData((await f.text()).trim());
              }}
            />
          </label>
          <label className="field">
            {t("import.paste")}
            <textarea className="input mono" rows={3} value={data} onChange={(e) => setData(e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            {t("import.password")}
            <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || (mode === "phrase" ? !phrase.trim() : !data.trim() || !password)}>
        {busy ? t("import.importing") : t("import.submit")}
      </Button>
    </form>
  );
}

/** Reveal the recovery phrase, export an encrypted .pqcbackup, or import. */
export function BackupDialog({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: Tab }) {
  const { t } = useTranslation("wallet");
  const { wallet } = useWallet();
  const hasPhrase = !!wallet?.mnemonic;
  const [tab, setTab] = useState<Tab>(initialTab ?? (hasPhrase ? "phrase" : wallet ? "export" : "import"));
  const [revealed, setRevealed] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  const close = () => {
    setRevealed(false);
    setPw("");
    setPw2("");
    setExported(null);
    onClose();
  };

  const exportBackup = async () => {
    if (!wallet) return;
    if (pw.length < 8) return toast.error(t("backup.passwordMin", { count: 8 }));
    if (pw !== pw2) return toast.error(t("backup.passwordMismatch"));
    setBusy(true);
    try {
      const encrypted = await encryptWallet(wallet, pw);
      const fileName = `xrge-wallet-backup-${wallet.displayName.replace(/\s+/g, "-")}-${Date.now()}.pqcbackup`;
      if (download(encrypted, fileName)) toast.success(t("backup.exported"), { description: t("backup.exportedBody") });
      setExported(encrypted); // copy fallback (mobile browsers may block downloads)
      setPw("");
      setPw2("");
    } catch {
      toast.error(t("backup.exportFailed"));
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    ...(hasPhrase ? [{ id: "phrase" as const, label: t("backup.tabPhrase") }] : []),
    ...(wallet ? [{ id: "export" as const, label: t("backup.tabExport") }] : []),
    { id: "import", label: t("backup.tabImport") },
  ];

  return (
    <Dialog open={open} onClose={close} title={t("backup.title")}>
      <div className="mode-switch tabs" role="tablist" aria-label={t("backup.options")}>
        {tabs.map((tb) => (
          <Button key={tb.id} role="tab" aria-selected={tab === tb.id} variant={tab === tb.id ? "secondary small" : "ghost small"} onClick={() => setTab(tb.id)}>
            {tb.label}
          </Button>
        ))}
      </div>

      {tab === "phrase" && wallet?.mnemonic && (
        <div className="wallet-form">
          <p className="notice warning">{t("backup.phraseWarning")}</p>
          {revealed ? (
            <>
              <PhraseGrid phrase={wallet.mnemonic} />
              <div className="actions">
                <CopyText value={wallet.mnemonic} label={t("copy.recoveryPhrase")} display={t("backup.copyPhrase")} />
                <Button variant="outline small" onClick={() => setRevealed(false)}>
                  {t("backup.hide")}
                </Button>
              </div>
            </>
          ) : (
            <Button onClick={() => setRevealed(true)}>{t("backup.reveal")}</Button>
          )}
          <p className="form-hint">{t("backup.phraseHint")}</p>
        </div>
      )}

      {tab === "export" && wallet && (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            void exportBackup();
          }}
        >
          <p className="form-hint">{t("backup.exportHint")}</p>
          <label className="field">
            {t("backup.password")}
            <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="field">
            {t("backup.confirmPassword")}
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !pw || !pw2}>
            {busy ? t("backup.encrypting") : t("backup.export")}
          </Button>
          {exported && <CopyText value={exported} label={t("copy.backupData")} display={t("backup.copyData")} />}
        </form>
      )}

      {tab === "import" && <ImportForm onDone={close} />}
    </Dialog>
  );
}
