import { useState, useRef } from "react";
import { motion } from "framer-motion";
import { X, Plus, Loader2, AlertCircle, Coins, CheckCircle2, ImageIcon, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createToken, TOKEN_CREATION_FEE, WalletBalance } from "@/lib/pqc-wallet";
import { secureCreateToken } from "@/lib/secure-api";
import { fileToLogoDataUri } from "@/lib/image-utils";

interface CreateTokenDialogProps {
  wallet: {
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  balances: WalletBalance[];
  onClose: () => void;
  onSuccess: (tokenAddress: string) => void;
}

const CreateTokenDialog = ({ wallet, balances, onClose, onSuccess }: CreateTokenDialogProps) => {
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [totalSupply, setTotalSupply] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [createdToken, setCreatedToken] = useState<{ address: string; symbol: string } | null>(null);

  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  const hasEnoughFee = xrgeBalance >= TOKEN_CREATION_FEE;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    try {
      const dataUri = await fileToLogoDataUri(file);
      setImageUrl(dataUri);
    } catch (err) {
      toast.error("Failed to process image", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCreate = async () => {
    setError("");

    if (!tokenName.trim()) {
      setError("Token name is required");
      return;
    }

    if (!tokenSymbol.trim()) {
      setError("Token symbol is required");
      return;
    }

    if (tokenSymbol.length > 10) {
      setError("Symbol must be 10 characters or less");
      return;
    }

    const supply = parseInt(totalSupply);
    if (isNaN(supply) || supply <= 0) {
      setError("Invalid total supply");
      return;
    }

    if (!hasEnoughFee) {
      setError(`Insufficient XRGE. Need ${TOKEN_CREATION_FEE} XRGE for token creation fee`);
      return;
    }

    setCreating(true);
    try {
      const sym = tokenSymbol.trim().toUpperCase();
      const trimmedImage = imageUrl.trim() || undefined;

      const result = await secureCreateToken(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        tokenName.trim(),
        sym,
        supply,
        100,
        trimmedImage
      );

      if (!result.success) {
        throw new Error(result.error || "Token creation failed");
      }

      const tokenAddress = `token:${wallet.signingPublicKey.slice(0, 16)}:${sym.toLowerCase()}`;
      setCreatedToken({ address: tokenAddress, symbol: sym });
      toast.success(`Token ${sym} created!`);
    } catch (err) {
      console.error("Token creation error:", err);
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const handleDone = () => {
    if (createdToken) {
      onSuccess(createdToken.address);
    }
    onClose();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-xl"
      >
        {createdToken ? (
          /* Success state */
          <div className="text-center py-4">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center"
            >
              <CheckCircle2 className="w-8 h-8 text-success" />
            </motion.div>
            <h2 className="text-xl font-bold text-foreground mb-2">Token Created!</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Your token <span className="font-mono text-primary">{createdToken.symbol}</span> is now live on RougeChain
            </p>
            
            <div className="p-4 rounded-xl bg-secondary/50 border border-border mb-6 text-left">
              <p className="text-xs text-muted-foreground mb-1">Token Address (Quantum-Derived)</p>
              <p className="text-xs font-mono text-foreground break-all">{createdToken.address}</p>
            </div>

            <Button onClick={handleDone} className="w-full">
              Done
            </Button>
          </div>
        ) : (
          /* Creation form */
          <>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-primary" />
                <h2 className="text-xl font-bold text-foreground">Create Token</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* Fee notice */}
            <div className={`p-3 rounded-lg mb-4 flex items-center gap-2 ${
              hasEnoughFee 
                ? 'bg-primary/10 border border-primary/30' 
                : 'bg-destructive/10 border border-destructive/30'
            }`}>
              <Coins className={`w-4 h-4 ${hasEnoughFee ? 'text-primary' : 'text-destructive'}`} />
              <div className="flex-1">
                <p className={`text-xs font-medium ${hasEnoughFee ? 'text-primary' : 'text-destructive'}`}>
                  Creation Fee: {TOKEN_CREATION_FEE} XRGE
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Your balance: {xrgeBalance.toLocaleString()} XRGE
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <Label htmlFor="tokenName">Token Name</Label>
                <Input
                  id="tokenName"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="e.g. My Awesome Token"
                  className="mt-1.5"
                />
              </div>

              <div>
                <Label htmlFor="tokenSymbol">Symbol</Label>
                <Input
                  id="tokenSymbol"
                  value={tokenSymbol}
                  onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                  placeholder="e.g. MAT"
                  maxLength={10}
                  className="mt-1.5 font-mono uppercase"
                />
              </div>

              <div>
                <Label htmlFor="totalSupply">Total Supply</Label>
                <Input
                  id="totalSupply"
                  type="number"
                  value={totalSupply}
                  onChange={(e) => setTotalSupply(e.target.value)}
                  placeholder="e.g. 1000000"
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  You will receive all tokens at creation
                </p>
              </div>

              <div>
                <Label className="flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" />
                  Logo <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={uploadingImage}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadingImage ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                    ) : (
                      <Upload className="w-4 h-4 mr-1.5" />
                    )}
                    Upload
                  </Button>
                  <span className="text-xs text-muted-foreground">or</span>
                  <Input
                    value={imageUrl.startsWith("data:") ? "" : imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://example.com/logo.png"
                    className="flex-1"
                    disabled={uploadingImage}
                  />
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                {imageUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <img
                      src={imageUrl}
                      alt="Token logo preview"
                      className="w-10 h-10 rounded-full object-cover border border-border bg-secondary"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      onLoad={(e) => { (e.target as HTMLImageElement).style.display = "block"; }}
                    />
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">
                        {imageUrl.startsWith("data:") ? "Uploaded (stored on-chain)" : "URL preview"}
                      </span>
                      {imageUrl.startsWith("data:") && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {Math.round(imageUrl.length * 0.75 / 1024)} KB
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-6 w-6"
                      onClick={() => setImageUrl("")}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              <Button
                onClick={handleCreate}
                disabled={creating || !hasEnoughFee || !tokenName || !tokenSymbol || !totalSupply}
                className="w-full"
              >
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating Token...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Token ({TOKEN_CREATION_FEE} XRGE)
                  </>
                )}
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Token address will be derived from the block hash using quantum-safe cryptography
              </p>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
};

export default CreateTokenDialog;
