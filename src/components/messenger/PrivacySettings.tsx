import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Shield, Eye, EyeOff, Trash2, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { 
  getPrivacySettings, 
  savePrivacySettings, 
  clearStoredSentMessages,
  type PrivacySettings as PrivacySettingsType 
} from "@/lib/pqc-messenger";
import { toast } from "sonner";

interface PrivacySettingsProps {
  onClose: () => void;
}

const PrivacySettings = ({ onClose }: PrivacySettingsProps) => {
  const [settings, setSettings] = useState<PrivacySettingsType>({ storeSentMessages: true });

  useEffect(() => {
    setSettings(getPrivacySettings());
  }, []);

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

          {/* Clear stored messages */}
          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={handleClearMessages}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Clear All Stored Sent Messages
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default PrivacySettings;
