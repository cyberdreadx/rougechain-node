import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Shield, Eye, EyeOff, Trash2, X, AlertTriangle, User, Save, Loader2, RefreshCw, Key, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { 
  getPrivacySettings, 
  savePrivacySettings, 
  clearStoredSentMessages,
  registerWalletOnNode,
  generateEncryptionKeypair,
  type PrivacySettings as PrivacySettingsType 
} from "@/lib/pqc-messenger";
import { loadUnifiedWallet, saveUnifiedWallet } from "@/lib/unified-wallet";
import { toast } from "sonner";

interface PrivacySettingsProps {
  onClose: () => void;
  onProfileUpdated?: () => void;
}

const PrivacySettings = ({ onClose, onProfileUpdated }: PrivacySettingsProps) => {
  const [settings, setSettings] = useState<PrivacySettingsType>({ storeSentMessages: true, discoverable: true });
  const [displayName, setDisplayName] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    setSettings(getPrivacySettings());
    const wallet = loadUnifiedWallet();
    if (wallet) {
      setDisplayName(wallet.displayName || "");
      setOriginalName(wallet.displayName || "");
    }
  }, []);

  const handleSaveProfile = async () => {
    if (!displayName.trim() || displayName === originalName) return;
    
    setIsSaving(true);
    try {
      const wallet = loadUnifiedWallet();
      if (!wallet) throw new Error("No wallet found");
      
      // Update local wallet
      wallet.displayName = displayName.trim();
      saveUnifiedWallet(wallet);
      
      // Re-register with server to update name
      await registerWalletOnNode({
        id: wallet.signingPublicKey,
        displayName: wallet.displayName,
        signingPublicKey: wallet.signingPublicKey,
        encryptionPublicKey: wallet.encryptionPublicKey || "",
      });
      
      setOriginalName(displayName.trim());
      toast.success("Profile updated");
      onProfileUpdated?.();
    } catch (error) {
      console.error("Failed to update profile:", error);
      toast.error("Failed to update profile");
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetEncryptionKeys = async () => {
    if (!confirm(
      "⚠️ Reset Encryption Keys?\n\n" +
      "This will:\n" +
      "• Generate new ML-KEM-768 encryption keys\n" +
      "• Re-register your wallet with the network\n" +
      "• Make all OLD messages permanently unreadable\n\n" +
      "New messages will work correctly.\n\n" +
      "Are you sure?"
    )) return;

    setIsResetting(true);
    try {
      const wallet = loadUnifiedWallet();
      if (!wallet) throw new Error("No wallet found");

      // Generate new encryption keys
      const newKeys = generateEncryptionKeypair();
      wallet.encryptionPublicKey = newKeys.publicKey;
      wallet.encryptionPrivateKey = newKeys.privateKey;
      
      // Save locally
      saveUnifiedWallet(wallet);

      // Re-register with server
      await registerWalletOnNode({
        id: wallet.signingPublicKey,
        displayName: wallet.displayName || "My Wallet",
        signingPublicKey: wallet.signingPublicKey,
        encryptionPublicKey: wallet.encryptionPublicKey,
      });

      // Clear stored sent messages (they reference old keys)
      clearStoredSentMessages();

      toast.success("Encryption keys reset", {
        description: "New keys generated. Old messages are now unreadable.",
      });
      onProfileUpdated?.();
    } catch (error) {
      console.error("Failed to reset keys:", error);
      toast.error("Failed to reset encryption keys");
    } finally {
      setIsResetting(false);
    }
  };

  const handleToggleStorage = (enabled: boolean) => {
    const newSettings = { ...settings, storeSentMessages: enabled };
    setSettings(newSettings);
    savePrivacySettings(newSettings);
    
    if (enabled) {
      toast.success("Sent message storage enabled", {
        description: "Your sent messages will be readable after refresh",
      });
    } else {
      toast.info("Sent message storage disabled", {
        description: "Sent messages will show as encrypted",
      });
    }
  };

  const handleClearMessages = () => {
    clearStoredSentMessages();
    toast.success("Stored messages cleared", {
      description: "All locally stored sent messages have been deleted",
    });
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
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="bg-card border border-border rounded-xl shadow-2xl max-w-sm w-full flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card rounded-t-xl shrink-0">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-sm text-foreground">Privacy & Security</h3>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 p-3 space-y-3">
          {/* Profile — inline name + save */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border">
            <Label htmlFor="displayName" className="text-[11px] text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <User className="w-3 h-3" /> Display Name
            </Label>
            <div className="flex gap-2">
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="h-8 text-sm"
              />
              <Button
                size="sm"
                onClick={handleSaveProfile}
                disabled={isSaving || !displayName.trim() || displayName === originalName}
                className="h-8 px-3 shrink-0"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>

          {/* Toggle row: Discoverable */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="flex items-center gap-2 min-w-0">
              <Globe className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">Discoverable</p>
                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  {settings.discoverable ? "Visible in New Chat picker" : "Hidden — address or QR only"}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.discoverable}
              onCheckedChange={async (enabled) => {
                const newSettings = { ...settings, discoverable: enabled };
                setSettings(newSettings);
                savePrivacySettings(newSettings);
                if (enabled) {
                  try {
                    const wallet = loadUnifiedWallet();
                    if (wallet) {
                      await registerWalletOnNode({
                        id: wallet.signingPublicKey,
                        displayName: wallet.displayName,
                        signingPublicKey: wallet.signingPublicKey,
                        encryptionPublicKey: wallet.encryptionPublicKey || "",
                      });
                    }
                  } catch { /* ignore */ }
                  toast.success("You are now discoverable");
                } else {
                  toast.info("You are now hidden");
                }
                onProfileUpdated?.();
              }}
            />
          </div>

          {/* Toggle row: Store Sent Messages */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="flex items-center gap-2 min-w-0">
              {settings.storeSentMessages ? (
                <Eye className="w-4 h-4 text-primary shrink-0" />
              ) : (
                <EyeOff className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">Store Sent Messages</p>
                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  {settings.storeSentMessages ? "Readable after refresh" : "Shows as encrypted"}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.storeSentMessages}
              onCheckedChange={handleToggleStorage}
            />
          </div>

          {/* Compact security note */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20">
            <AlertTriangle className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground leading-snug">
              Data is stored in localStorage — as secure as your private keys. Anyone with browser access could read both.
            </p>
          </div>

          {/* Danger zone */}
          <div className="pt-2 border-t border-border space-y-2">
            <p className="text-[10px] text-destructive/60 uppercase tracking-wider font-medium">Danger Zone</p>
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={handleResetEncryptionKeys}
              disabled={isResetting}
            >
              {isResetting ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Key className="w-3.5 h-3.5 mr-1.5" />
              )}
              Reset Encryption Keys
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-8 text-xs text-muted-foreground"
              onClick={handleClearMessages}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Clear Stored Messages
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default PrivacySettings;
