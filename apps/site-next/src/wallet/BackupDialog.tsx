import { useState } from "react";
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
      toast.success(mode === "phrase" ? "Wallet recovered from recovery phrase" : "Wallet imported");
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
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
      <div className="mode-switch" role="group" aria-label="Import from">
        <Button type="button" variant={mode === "phrase" ? "secondary small" : "ghost small"} aria-pressed={mode === "phrase"} onClick={() => setMode("phrase")}>
          Recovery phrase
        </Button>
        <Button type="button" variant={mode === "backup" ? "secondary small" : "ghost small"} aria-pressed={mode === "backup"} onClick={() => setMode("backup")}>
          .pqcbackup file
        </Button>
      </div>
      {mode === "phrase" ? (
        <label className="field">
          12 or 24 words
          <textarea className="input mono" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      ) : (
        <>
          <label className="field">
            Backup file
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
            …or paste the backup data
            <textarea className="input mono" rows={3} value={data} onChange={(e) => setData(e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            Backup password
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
        {busy ? "Importing…" : "Import wallet"}
      </Button>
    </form>
  );
}

/** Reveal the recovery phrase, export an encrypted .pqcbackup, or import. */
export function BackupDialog({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: Tab }) {
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
    if (pw.length < 8) return toast.error("Password must be at least 8 characters");
    if (pw !== pw2) return toast.error("Passwords don't match");
    setBusy(true);
    try {
      const encrypted = await encryptWallet(wallet, pw);
      const fileName = `xrge-wallet-backup-${wallet.displayName.replace(/\s+/g, "-")}-${Date.now()}.pqcbackup`;
      if (download(encrypted, fileName)) toast.success("Backup exported", { description: "Keep the file and its password somewhere safe." });
      setExported(encrypted); // copy fallback (mobile browsers may block downloads)
      setPw("");
      setPw2("");
    } catch {
      toast.error("Export failed");
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    ...(hasPhrase ? [{ id: "phrase" as const, label: "Recovery phrase" }] : []),
    ...(wallet ? [{ id: "export" as const, label: "Export backup" }] : []),
    { id: "import", label: "Import" },
  ];

  return (
    <Dialog open={open} onClose={close} title="Backup & recovery">
      <div className="mode-switch tabs" role="tablist" aria-label="Backup options">
        {tabs.map((t) => (
          <Button key={t.id} role="tab" aria-selected={tab === t.id} variant={tab === t.id ? "secondary small" : "ghost small"} onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
      </div>

      {tab === "phrase" && wallet?.mnemonic && (
        <div className="wallet-form">
          <p className="notice warning">Anyone with these words controls your funds. Never share them or type them into another site.</p>
          {revealed ? (
            <>
              <PhraseGrid phrase={wallet.mnemonic} />
              <div className="actions">
                <CopyText value={wallet.mnemonic} label="recovery phrase" display="Copy phrase" />
                <Button variant="outline small" onClick={() => setRevealed(false)}>
                  Hide
                </Button>
              </div>
            </>
          ) : (
            <Button onClick={() => setRevealed(true)}>Reveal recovery phrase</Button>
          )}
          <p className="form-hint">The phrase restores your wallet and funds — not your chat history. Use an encrypted backup for that.</p>
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
          <p className="form-hint">An encrypted .pqcbackup file (AES-256-GCM, PBKDF2 600k) restores your wallet, funds and messages.</p>
          <label className="field">
            Backup password
            <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="field">
            Confirm password
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !pw || !pw2}>
            {busy ? "Encrypting…" : "Export .pqcbackup"}
          </Button>
          {exported && <CopyText value={exported} label="backup data" display="Copy backup data" />}
        </form>
      )}

      {tab === "import" && <ImportForm onDone={close} />}
    </Dialog>
  );
}
