import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Copy, Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { toDataURL } from "qrcode";
import { pubkeyToAddress, formatAddress } from "@/lib/address";

interface ReceiveDialogProps {
  publicKey: string;
  onClose: () => void;
}

const ReceiveDialog = ({ publicKey, onClose }: ReceiveDialogProps) => {
  const [copied, setCopied] = useState<"addr" | "pk" | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [rougeAddr, setRougeAddr] = useState<string | null>(null);

  // Derive the rouge1... address from the pubkey
  useEffect(() => {
    let cancelled = false;
    pubkeyToAddress(publicKey)
      .then((addr) => {
        if (!cancelled) setRougeAddr(addr);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [publicKey]);

  // Generate QR from the rouge1 address (fits in a single standard QR)
  useEffect(() => {
    if (!rougeAddr) return;
    const generateQR = async () => {
      try {
        const qr = await toDataURL(rougeAddr, {
          width: 200,
          margin: 2,
          errorCorrectionLevel: "M",
          color: {
            dark: "#000000",
            light: "#ffffff",
          },
        });
        setQrDataUrl(qr);
      } catch (err) {
        console.error("QR generation error:", err);
      }
    };
    generateQR();
  }, [rougeAddr]);

  const displayAddr = rougeAddr ? formatAddress(rougeAddr, 14, 6) : "";

  const copyAddress = () => {
    if (!rougeAddr) return;
    navigator.clipboard.writeText(rougeAddr);
    setCopied("addr");
    toast.success("Address copied!");
    setTimeout(() => setCopied(null), 2000);
  };

  const copyPubkey = () => {
    navigator.clipboard.writeText(publicKey);
    setCopied("pk");
    toast.success("Public key copied!");
    setTimeout(() => setCopied(null), 2000);
  };

  const shareAddress = async () => {
    if (!rougeAddr) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "My RougeChain Address",
          text: rougeAddr,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          copyAddress();
        }
      }
    } else {
      copyAddress();
    }
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
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-foreground">Receive XRGE</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="space-y-4">
          {/* QR Code */}
          {qrDataUrl ? (
            <div className="bg-white rounded-xl p-3 mx-auto max-w-[200px]">
              <img
                src={qrDataUrl}
                alt="RougeChain Address QR"
                className="w-full h-auto rounded-lg"
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px]">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          )}

          {/* Rouge1 Address */}
          <div className="p-3 rounded-xl bg-secondary/50 border border-border">
            <p className="text-[10px] text-muted-foreground mb-1">Wallet Address</p>
            <p className="font-mono text-sm text-primary break-all leading-relaxed select-all">
              {rougeAddr ?? displayAddr}
            </p>
          </div>

          {/* Public Key (collapsed) */}
          <div className="p-3 rounded-xl bg-muted/30 border border-border">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground">Public Key</p>
              <button
                onClick={copyPubkey}
                className="p-1 hover:bg-secondary rounded transition-colors"
                title="Copy public key"
              >
                {copied === "pk" ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3 text-muted-foreground" />
                )}
              </button>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground break-all leading-relaxed select-all mt-1">
              {publicKey.slice(0, 32)}...{publicKey.slice(-16)}
            </p>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={copyAddress} className="w-full" size="sm" variant={copied === "addr" ? "default" : "outline"}>
              {copied === "addr" ? (
                <>
                  <Check className="w-4 h-4 mr-1" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" />
                  Copy Address
                </>
              )}
            </Button>
            <Button onClick={shareAddress} className="w-full" size="sm" variant="outline">
              <Share2 className="w-4 h-4 mr-1" />
              Share
            </Button>
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Send XRGE or tokens to this address. Scan the QR code or share the <span className="font-mono">rouge1...</span> address.
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default ReceiveDialog;
