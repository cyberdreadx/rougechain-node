import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Image, Globe, FileText, Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { updateTokenMetadata, getTokenMetadata, TokenMetadata } from "@/lib/secure-api";

interface UpdateTokenMetadataDialogProps {
  tokenSymbol: string;
  walletPublicKey: string;
  walletPrivateKey: string;
  onClose: () => void;
  onSuccess?: () => void;
}

const UpdateTokenMetadataDialog = ({
  tokenSymbol,
  walletPublicKey,
  walletPrivateKey,
  onClose,
  onSuccess,
}: UpdateTokenMetadataDialogProps) => {
  const [loading, setLoading] = useState(false);
  const [loadingMetadata, setLoadingMetadata] = useState(true);
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [discord, setDiscord] = useState("");
  const [isCreator, setIsCreator] = useState(false);
  const [existingMetadata, setExistingMetadata] = useState<TokenMetadata | null>(null);

  // Load existing metadata
  useEffect(() => {
    async function loadMetadata() {
      try {
        const result = await getTokenMetadata(tokenSymbol);
        if (result.success && result.data) {
          setExistingMetadata(result.data);
          setImage(result.data.image || "");
          setDescription(result.data.description || "");
          setWebsite(result.data.website || "");
          setTwitter(result.data.twitter || "");
          setDiscord(result.data.discord || "");
          setIsCreator(result.data.creator === walletPublicKey);
        }
      } catch (e) {
        console.error("Failed to load metadata:", e);
      } finally {
        setLoadingMetadata(false);
      }
    }
    loadMetadata();
  }, [tokenSymbol, walletPublicKey]);

  const handleSubmit = async () => {
    if (!isCreator) {
      toast.error("Only the token creator can update metadata");
      return;
    }

    setLoading(true);
    try {
      const result = await updateTokenMetadata(
        walletPublicKey,
        walletPrivateKey,
        tokenSymbol,
        {
          image: image || undefined,
          description: description || undefined,
          website: website || undefined,
          twitter: twitter || undefined,
          discord: discord || undefined,
        }
      );

      if (result.success) {
        toast.success("Token metadata updated!", {
          description: `${tokenSymbol} metadata has been updated on-chain`,
        });
        onSuccess?.();
        onClose();
      } else {
        toast.error("Failed to update metadata", {
          description: result.error,
        });
      }
    } catch (e) {
      toast.error("Failed to update metadata");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Image className="w-5 h-5 text-primary" />
            <span className="font-semibold">Update Token Metadata</span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {loadingMetadata ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !isCreator ? (
            <div className="flex flex-col items-center py-8 text-center">
              <AlertCircle className="w-12 h-12 text-destructive mb-4" />
              <p className="text-sm text-muted-foreground">
                Only the token creator can update metadata.
              </p>
              {existingMetadata && (
                <p className="text-xs text-muted-foreground mt-2">
                  Creator: {existingMetadata.creator.slice(0, 12)}...
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                <div className="flex items-center gap-2 text-primary text-sm font-medium">
                  <Check className="w-4 h-4" />
                  You are the creator of {tokenSymbol}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="image" className="flex items-center gap-2">
                  <Image className="w-4 h-4" />
                  Image URL
                </Label>
                <Input
                  id="image"
                  placeholder="https://... or ipfs://..."
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Supports HTTP, HTTPS, IPFS, or data URIs
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description" className="flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Description
                </Label>
                <Textarea
                  id="description"
                  placeholder="Describe your token..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="website" className="flex items-center gap-2">
                  <Globe className="w-4 h-4" />
                  Website
                </Label>
                <Input
                  id="website"
                  placeholder="https://yourproject.com"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="twitter" className="flex items-center gap-2">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    X
                  </Label>
                  <Input
                    id="twitter"
                    placeholder="@handle"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="discord" className="flex items-center gap-2">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                    </svg>
                    Discord
                  </Label>
                  <Input
                    id="discord"
                    placeholder="discord.gg/..."
                    value={discord}
                    onChange={(e) => setDiscord(e.target.value)}
                  />
                </div>
              </div>

              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Updating...
                  </>
                ) : (
                  "Update Metadata"
                )}
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

export default UpdateTokenMetadataDialog;
