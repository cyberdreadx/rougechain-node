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
import type { WalletWithPrivateKeys } from "@/lib/pqc-messenger";

interface WalletBackupProps {
  wallet: WalletWithPrivateKeys;
  onClose: () => void;
  onImport: (wallet: WalletWithPrivateKeys) => void;
}

// Derive encryption key from password using PBKDF2
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt wallet data
async function encryptWallet(wallet: WalletWithPrivateKeys, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify({
    id: wallet.id,
    displayName: wallet.displayName,
    signingPublicKey: wallet.signingPublicKey,
    signingPrivateKey: wallet.signingPrivateKey,
    encryptionPublicKey: wallet.encryptionPublicKey,
    encryptionPrivateKey: wallet.encryptionPrivateKey,
    createdAt: wallet.createdAt,
    version: 1
  }));
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  
  // Combine salt + iv + encrypted data
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  
  // Convert to base64
  return btoa(String.fromCharCode(...combined));
}

// Decrypt wallet data
async function decryptWallet(encryptedData: string, password: string): Promise<WalletWithPrivateKeys> {
  // Decode base64
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
  
  // Extract salt, iv, and encrypted data
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);
  
  const key = await deriveKey(password, salt);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );
  
  const decoder = new TextDecoder();
  const walletData = JSON.parse(decoder.decode(decrypted));
  
  return {
    id: walletData.id,
    displayName: walletData.displayName,
    signingPublicKey: walletData.signingPublicKey,
    signingPrivateKey: walletData.signingPrivateKey,
    encryptionPublicKey: walletData.encryptionPublicKey,
    encryptionPrivateKey: walletData.encryptionPrivateKey,
    createdAt: walletData.createdAt
  };
}

const WalletBackup = ({ wallet, onClose, onImport }: WalletBackupProps) => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importData, setImportData] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [showImportPassword, setShowImportPassword] = useState(false);

  const handleExport = async () => {
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
      a.download = `pqc-wallet-backup-${wallet.displayName.replace(/\s+/g, "-")}-${Date.now()}.pqcbackup`;
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
              <p className="text-xs text-muted-foreground">Export or import your wallet</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <Tabs defaultValue="export" className="w-full">
          <TabsList className="grid w-full grid-cols-2 m-4 mb-0" style={{ width: "calc(100% - 2rem)" }}>
            <TabsTrigger value="export" className="gap-2">
              <Download className="w-4 h-4" />
              Export
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-2">
              <Upload className="w-4 h-4" />
              Import
            </TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="p-4 pt-2 space-y-4">
            {/* Current wallet info */}
            <div className="p-3 rounded-lg bg-muted/30 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <Key className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-foreground">{wallet.displayName}</span>
              </div>
              <p className="text-xs text-muted-foreground font-mono truncate">
                {wallet.id}
              </p>
            </div>

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
                    Store your password securely—it cannot be recovered.
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
            {/* Warning */}
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
        </Tabs>
      </motion.div>
    </motion.div>
  );
};

export default WalletBackup;
