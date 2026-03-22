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
              <Shield className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Privacy Settings</h3>
              <p className="text-xs text-muted-foreground">Control your data storage</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          {/* Profile section */}
          <div className="p-4 rounded-lg bg-muted/30 border border-border">
            <div className="flex items-center gap-2 mb-3">
              <User className="w-4 h-4 text-primary" />
              <span className="font-medium text-foreground">Profile</span>
            </div>
            <div className="space-y-3">
              <div>
                <Label htmlFor="displayName" className="text-xs text-muted-foreground">Display Name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Enter your display name"
                  className="mt-1"
                />
              </div>
              <Button
                size="sm"
                onClick={handleSaveProfile}
                disabled={isSaving || !displayName.trim() || displayName === originalName}
                className="w-full"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    Save Profile
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Discoverable toggle */}
          <div className="p-4 rounded-lg bg-muted/30 border border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Globe className="w-4 h-4 text-primary" />
                  <span className="font-medium text-foreground">Discoverable</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {settings.discoverable
                    ? "Your wallet appears in the contact picker so anyone on the network can start a chat with you."
                    : "Your wallet is hidden. Others can only message you if they know your rouge1 address or scan your QR code."
                  }
                </p>
              </div>
              <Switch
                checked={settings.discoverable}
                onCheckedChange={async (enabled) => {
                  const newSettings = { ...settings, discoverable: enabled };
                  setSettings(newSettings);
                  savePrivacySettings(newSettings);
                  if (enabled) {
                    // Re-register to make wallet visible
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
                    toast.success("You are now discoverable", {
                      description: "Others can find you in the New Chat picker",
                    });
                  } else {
                    toast.info("You are now hidden", {
                      description: "Others need your address to message you",
                    });
                  }
                  onProfileUpdated?.();
                }}
              />
            </div>
          </div>

          {/* Store sent messages toggle */}
          <div className="p-4 rounded-lg bg-muted/30 border border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {settings.storeSentMessages ? (
                    <Eye className="w-4 h-4 text-primary" />
                  ) : (
                    <EyeOff className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground">Store Sent Messages</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {settings.storeSentMessages 
                    ? "Your sent messages are stored locally so you can read them after refreshing the page."
                    : "Sent messages will display as \"[Your encrypted message]\" since only the recipient can decrypt them."
                  }
                </p>
              </div>
              <Switch
                checked={settings.storeSentMessages}
                onCheckedChange={handleToggleStorage}
              />
            </div>
          </div>

          {/* Security note */}
          <div className="p-3 rounded-lg bg-accent/10 border border-accent/20">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Security Note</p>
                <p>
                  Stored messages are kept in your browser's localStorage. They're as secure as your 
                  private keys (which are also stored locally). If someone accesses your browser, 
                  they could read both.
                </p>
              </div>
            </div>
          </div>

          {/* Reset encryption keys */}
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
            <div className="flex items-center gap-2 mb-2">
              <Key className="w-4 h-4 text-destructive" />
              <span className="font-medium text-foreground">Reset Encryption Keys</span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              If you're having decryption issues, resetting your encryption keys will fix future messages.
              <strong className="text-destructive"> Warning: All old messages will become permanently unreadable.</strong>
            </p>
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={handleResetEncryptionKeys}
              disabled={isResetting}
            >
              {isResetting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Resetting...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Reset Encryption Keys
                </>
              )}
            </Button>
          </div>

          {/* Clear stored messages */}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleClearMessages}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Clear Stored Sent Messages
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default PrivacySettings;
