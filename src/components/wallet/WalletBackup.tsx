import { useState } from "react";
import { motion } from "framer-motion";
import { 
  Download, 
  Upload, 
  X, 
  Key, 
  Shield, 
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileKey2
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
      
      // Create downloadable file
      const blob = new Blob([encrypted], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `xrge-wallet-backup-${wallet.displayName.replace(/\s+/g, "-")}-${Date.now()}.pqcbackup`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success("Wallet exported successfully", {
        description: "Store your backup file and password securely"
      });
      
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

        <Tabs defaultValue={importOnly ? "import" : "export"} className="w-full">
          {!importOnly ? (
            <TabsList className="grid w-full grid-cols-3 m-4 mb-0" style={{ width: "calc(100% - 2rem)" }}>
              <TabsTrigger value="export" className="gap-2">
                <Download className="w-4 h-4" />
                Export
              </TabsTrigger>
              <TabsTrigger value="import" className="gap-2">
                <Upload className="w-4 h-4" />
                Import
              </TabsTrigger>
              <TabsTrigger value="vault" className="gap-2">
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
                    Your wallet will be encrypted with PBKDF2 (100k iterations) + AES-256-GCM. 
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
                accept=".pqcbackup,.txt"
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
