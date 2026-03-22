import { useState } from "react";
import { motion } from "framer-motion";
import { 
  Download, 
  Upload, 
  X, 
  Key, 
  KeyRound,
  Shield, 
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileKey2,
  Copy,
  Check,
  Share2,
  Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { 
  UnifiedWallet, 
  VaultSettings,
  encryptWallet, 
  decryptWallet,
  lockUnifiedWallet 
} from "@/lib/unified-wallet";

interface WalletBackupProps {
  wallet?: UnifiedWallet | null;
  onClose: () => void;
  onImport: (wallet: UnifiedWallet) => void;
  onLocked?: () => void;
  vaultSettings?: VaultSettings;
  onUpdateVaultSettings?: (settings: VaultSettings) => void;
}

const WalletBackup = ({ wallet, onClose, onImport, onLocked, vaultSettings, onUpdateVaultSettings }: WalletBackupProps) => {
  // Import-only mode when wallet is null
  const importOnly = !wallet;
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importData, setImportData] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultConfirm, setVaultConfirm] = useState("");
  const [vaultProcessing, setVaultProcessing] = useState(false);
  const [showSeedPhrase, setShowSeedPhrase] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);
  const [seedImportPhrase, setSeedImportPhrase] = useState("");
  const [seedImportError, setSeedImportError] = useState("");
  const [isRecovering, setIsRecovering] = useState(false);
  const [showSeedImport, setShowSeedImport] = useState(false);

  const [exportedData, setExportedData] = useState<string | null>(null);
  const [exportFileName, setExportFileName] = useState("");
  const [copied, setCopied] = useState(false);
  const triggerDownload = (data: string, fileName: string): boolean => {
    try {
      const blob = new Blob([data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      // Delay revoke so the browser has time to start the download
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 3000);
      return true;
    } catch {
      return false;
    }
  };

  const handleExport = async () => {
    if (!wallet) return;
    
    if (password.length < 8) {
      toast.error("Password too short", {
        description: "Password must be at least 8 characters"
      });
      return;
    }
    
    if (password !== confirmPassword) {
      toast.error("Passwords don't match", {
        description: "Please ensure both passwords are identical"
      });
      return;
    }

    setIsProcessing(true);
    try {
      const encrypted = await encryptWallet(wallet, password);
      const fileName = `xrge-wallet-backup-${wallet.displayName.replace(/\s+/g, "-")}-${Date.now()}.pqcbackup`;

      // Try native File System Access API first (Chrome/Edge on desktop)
      if ("showSaveFilePicker" in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: "PQC Wallet Backup", accept: { "application/octet-stream": [".pqcbackup"] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(encrypted);
          await writable.close();
          toast.success("Wallet exported successfully", {
            description: "Store your backup file and password securely"
          });
          setPassword("");
          setConfirmPassword("");
          setIsProcessing(false);
          return;
        } catch (e: any) {
          if (e?.name === "AbortError") {
            setIsProcessing(false);
            return;
          }
          // Fall through to other methods
        }
      }

      // Try standard download link
      const downloaded = triggerDownload(encrypted, fileName);

      if (downloaded) {
        toast.success("Wallet exported successfully", {
          description: "Store your backup file and password securely"
        });
      }

      // Always show the backup data as fallback so users can copy it
      // (mobile browsers often silently block programmatic downloads)
      setExportedData(encrypted);
      setExportFileName(fileName);

      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      console.error("Export failed:", error);
      toast.error("Export failed", {
        description: "An error occurred while encrypting your wallet"
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopyBackup = async () => {
    if (!exportedData) return;
    try {
      await navigator.clipboard.writeText(exportedData);
      setCopied(true);
      toast.success("Backup copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleShareBackup = async () => {
    if (!exportedData) return;
    try {
      const file = new File([exportedData], exportFileName, { type: "application/octet-stream" });
      await navigator.share({ files: [file], title: "XRGE Wallet Backup" });
      toast.success("Backup shared successfully");
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        toast.error("Share failed — try copying instead");
      }
    }
  };

  const handleImport = async () => {
    if (!importData.trim()) {
      toast.error("No backup data", {
        description: "Please paste your backup data or select a file"
      });
      return;
    }
    
    if (!importPassword) {
      toast.error("Password required", {
        description: "Enter the password used when creating the backup"
      });
      return;
    }

    setIsProcessing(true);
    try {
      const decrypted = await decryptWallet(importData.trim(), importPassword);
      onImport(decrypted);
      toast.success("Wallet imported successfully", {
        description: `Welcome back, ${decrypted.displayName}!`
      });
      onClose();
    } catch (error) {
      console.error("Import failed:", error);
      toast.error("Import failed", {
        description: "Invalid backup data or wrong password"
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      setImportData(text);
      toast.success("File loaded", {
        description: "Now enter your backup password"
      });
    } catch {
      toast.error("Failed to read file");
    }
  };

  const handleLock = async () => {
    if (vaultPassword.length < 8) {
      toast.error("Password too short", {
        description: "Password must be at least 8 characters",
      });
      return;
    }
    if (vaultPassword !== vaultConfirm) {
      toast.error("Passwords don't match", {
        description: "Please ensure both passwords are identical",
      });
      return;
    }
    setVaultProcessing(true);
    try {
      await lockUnifiedWallet(vaultPassword);
      toast.success("Wallet locked", {
        description: "Unlock with your vault password",
      });
      onLocked();
      onClose();
    } catch (error) {
      console.error("Lock failed:", error);
      toast.error("Lock failed", {
        description: "Unable to encrypt and lock wallet",
      });
    } finally {
      setVaultProcessing(false);
      setVaultPassword("");
      setVaultConfirm("");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        className="bg-card border border-border rounded-xl shadow-2xl max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <FileKey2 className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Wallet Backup</h3>
              <p className="text-xs text-muted-foreground">Export or import your unified wallet</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <Tabs defaultValue={importOnly ? "import" : (wallet?.mnemonic ? "seed" : "export")} className="w-full">
          {!importOnly ? (
            <TabsList className={`grid w-full m-4 mb-0 ${wallet?.mnemonic ? 'grid-cols-4' : 'grid-cols-3'}`} style={{ width: "calc(100% - 2rem)" }}>
              {wallet?.mnemonic && (
                <TabsTrigger value="seed" className="gap-1.5">
                  <KeyRound className="w-4 h-4" />
                  Seed
                </TabsTrigger>
              )}
              <TabsTrigger value="export" className="gap-1.5">
                <Download className="w-4 h-4" />
                Export
              </TabsTrigger>
              <TabsTrigger value="import" className="gap-1.5">
                <Upload className="w-4 h-4" />
                Import
              </TabsTrigger>
              <TabsTrigger value="vault" className="gap-1.5">
                <Shield className="w-4 h-4" />
                Vault
              </TabsTrigger>
            </TabsList>
          ) : (
            <div className="p-4 pb-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Upload className="w-4 h-4" />
                <span className="text-sm font-medium">Import Existing Wallet</span>
              </div>
            </div>
          )}

          {/* Seed Phrase Tab */}
          <TabsContent value="seed" className="p-4 pt-2 space-y-4">
            <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-warning mb-1">Recovery Phrase</p>
                  <p>
                    Never share your recovery phrase. Anyone with these words can access your wallet and funds.
                  </p>
                </div>
              </div>
            </div>

            {showSeedPhrase ? (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {wallet?.mnemonic?.split(" ").map((word, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-muted/50 border border-border">
                      <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}.</span>
                      <span className="text-xs font-mono text-foreground">{word}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={async () => {
                      if (wallet?.mnemonic) {
                        await navigator.clipboard.writeText(wallet.mnemonic);
                        setSeedCopied(true);
                        toast.success("Recovery phrase copied");
                        setTimeout(() => setSeedCopied(false), 2000);
                      }
                    }}
                  >
                    {seedCopied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                    {seedCopied ? "Copied!" : "Copy Phrase"}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setShowSeedPhrase(false)}
                  >
                    <EyeOff className="w-4 h-4 mr-2" />
                    Hide
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-6 rounded-lg bg-muted/30 border border-border flex flex-col items-center gap-3">
                  <KeyRound className="w-8 h-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground text-center">
                    {wallet?.mnemonic?.split(" ").length || 24} words · tap below to reveal
                  </p>
                </div>
                <Button className="w-full" onClick={() => setShowSeedPhrase(true)}>
                  <Eye className="w-4 h-4 mr-2" />
                  Reveal Recovery Phrase
                </Button>
              </div>
            )}

            <div className="p-3 rounded-lg bg-accent/10 border border-accent/20">
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Quantum-Safe Derivation</p>
                  <p>
                    Your seed phrase is derived using BIP-39 → HKDF-SHA256 → ML-DSA-65.
                    This provides 128-bit post-quantum security.
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="export" className="p-4 pt-2 space-y-4">
            {/* Current wallet info */}
            {wallet && (
              <div className="p-3 rounded-lg bg-muted/30 border border-border">
                <div className="flex items-center gap-2 mb-1">
                  <Key className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">{wallet.displayName}</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {wallet.signingPublicKey.slice(0, 20)}...
                </p>
                <div className="flex gap-2 mt-2">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-primary/20 text-primary">ML-DSA-65</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-accent/20 text-accent">ML-KEM-768</span>
                </div>
              </div>
            )}

            {/* Password input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Encryption Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Minimum 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Confirm Password</label>
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-destructive">Passwords don't match</p>
              )}
              {confirmPassword && password === confirmPassword && password.length >= 8 && (
                <p className="text-xs text-success flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Passwords match
                </p>
              )}
            </div>

            {/* Security note */}
            <div className="p-3 rounded-lg bg-accent/10 border border-accent/20">
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">AES-256-GCM Encryption</p>
                  <p>
                    Your wallet will be encrypted with PBKDF2 (600k iterations) + AES-256-GCM. 
                    This backup works for both Messenger and Blockchain features.
                  </p>
                </div>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleExport}
              disabled={isProcessing || password.length < 8 || password !== confirmPassword}
            >
              {isProcessing ? (
                <>Processing...</>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Export Encrypted Backup
                </>
              )}
            </Button>

            {exportedData && (
              <div className="space-y-3 pt-2 border-t border-border">
                <div className="p-3 rounded-lg bg-success/10 border border-success/20">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                    <div className="text-xs text-muted-foreground">
                      <p className="font-medium text-foreground mb-1">Backup Ready</p>
                      <p>
                        If the download didn't start automatically, use the buttons
                        below to save your backup.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={handleCopyBackup}>
                    {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? "Copied!" : "Copy Backup"}
                  </Button>
                  {"share" in navigator && (
                    <Button variant="outline" className="flex-1" onClick={handleShareBackup}>
                      <Share2 className="w-4 h-4 mr-2" />
                      Share File
                    </Button>
                  )}
                  <Button variant="outline" className="flex-1" onClick={() => triggerDownload(exportedData, exportFileName)}>
                    <Download className="w-4 h-4 mr-2" />
                    Retry
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="import" className="p-4 pt-2 space-y-4">
            {/* Warning - only show if there's an existing wallet */}
            {!importOnly ? (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <div className="text-xs text-muted-foreground">
                    <p className="font-medium text-destructive mb-1">Warning</p>
                    <p>
                      Importing a wallet will replace your current wallet. Make sure you have 
                      a backup of your current wallet first.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                <div className="flex items-start gap-2">
                  <Upload className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="text-xs text-muted-foreground">
                    <p className="font-medium text-foreground mb-1">Restore Your Wallet</p>
                    <p>
                      Upload your encrypted backup file and enter the password you used 
                      when creating the backup.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* File input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Backup File</label>
              <Input
                type="file"
                accept=".pqcbackup,.txt,application/octet-stream,text/plain,*/*"
                onChange={handleFileSelect}
                className="cursor-pointer"
              />
              {importData && (
                <p className="text-xs text-success flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Backup data loaded
                </p>
              )}
            </div>

            {/* Password input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Backup Password</label>
              <div className="relative">
                <Input
                  type={showImportPassword ? "text" : "password"}
                  placeholder="Enter backup password"
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowImportPassword(!showImportPassword)}
                >
                  {showImportPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleImport}
              disabled={isProcessing || !importData || !importPassword}
            >
              {isProcessing ? (
                <>Processing...</>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Import Wallet
                </>
              )}
            </Button>

            {/* Seed Phrase Recovery */}
            <div className="pt-3 border-t border-border space-y-3">
              <button
                onClick={() => setShowSeedImport(!showSeedImport)}
                className="w-full text-sm text-primary hover:text-primary/80 transition-colors flex items-center justify-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                {showSeedImport ? "Hide seed phrase import" : "Import from seed phrase instead"}
              </button>
              {showSeedImport && (
                <div className="space-y-2">
                  <textarea
                    placeholder="Enter your 24-word recovery phrase..."
                    value={seedImportPhrase}
                    onChange={e => { setSeedImportPhrase(e.target.value); setSeedImportError(""); }}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none font-mono"
                  />
                  {seedImportError && (
                    <p className="text-xs text-destructive">{seedImportError}</p>
                  )}
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={!seedImportPhrase.trim() || isRecovering}
                    onClick={async () => {
                      const trimmed = seedImportPhrase.trim().toLowerCase();
                      const words = trimmed.split(/\s+/);
                      if (words.length !== 12 && words.length !== 24) {
                        setSeedImportError("Seed phrase must be 12 or 24 words");
                        return;
                      }
                      setIsRecovering(true);
                      try {
                        const { validateMnemonic, keypairFromMnemonic } = await import("@/lib/mnemonic");
                        if (!validateMnemonic(trimmed)) {
                          setSeedImportError("Invalid seed phrase — check for typos");
                          setIsRecovering(false);
                          return;
                        }
                        const { publicKey, secretKey } = keypairFromMnemonic(trimmed);
                        const { generateEncryptionKeypair } = await import("@/lib/pqc-messenger");
                        const encKeys = generateEncryptionKeypair();
                        const recoveredWallet: UnifiedWallet = {
                          id: `wallet-${Date.now()}`,
                          displayName: "Recovered Wallet",
                          createdAt: Date.now(),
                          signingPublicKey: publicKey,
                          signingPrivateKey: secretKey,
                          encryptionPublicKey: encKeys.publicKey,
                          encryptionPrivateKey: encKeys.privateKey,
                          version: 2,
                          mnemonic: trimmed,
                        };
                        onImport(recoveredWallet);
                        toast.success("Wallet recovered from seed phrase!");
                        onClose();
                      } catch (err) {
                        console.error("Recovery failed:", err);
                        setSeedImportError("Recovery failed — please try again");
                      } finally {
                        setIsRecovering(false);
                      }
                    }}
                  >
                    {isRecovering ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Recovering...</>
                    ) : (
                      <><KeyRound className="w-4 h-4 mr-2" /> Recover from Seed Phrase</>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="vault" className="p-4 pt-2 space-y-4">
            <div className="p-3 rounded-lg bg-muted/30 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-foreground">Lock Wallet</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Encrypt your wallet and require a password to unlock it.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Vault Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Minimum 8 characters"
                  value={vaultPassword}
                  onChange={(e) => setVaultPassword(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Confirm Password</label>
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Re-enter password"
                value={vaultConfirm}
                onChange={(e) => setVaultConfirm(e.target.value)}
              />
              {vaultConfirm && vaultPassword !== vaultConfirm && (
                <p className="text-xs text-destructive">Passwords don't match</p>
              )}
              {vaultConfirm && vaultPassword === vaultConfirm && vaultPassword.length >= 8 && (
                <p className="text-xs text-success flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Passwords match
                </p>
              )}
            </div>

            <Button
              variant="outline"
              className="w-full"
              onClick={handleLock}
              disabled={vaultProcessing}
            >
              {vaultProcessing ? "Locking..." : "Lock Wallet"}
            </Button>

            <div className="p-3 rounded-lg bg-accent/10 border border-accent/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Auto-lock</p>
                  <p>Auto-lock requires a vault password. Set a timer below.</p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Auto-lock (minutes)</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={vaultSettings.autoLockMinutes}
                onChange={(e) => {
                  const value = Number(e.target.value || 0);
                  onUpdateVaultSettings({ autoLockMinutes: Math.max(0, value) });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Set to 0 to disable auto-lock.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
};

export default WalletBackup;
