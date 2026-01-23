import { useState } from "react";
import { motion } from "framer-motion";
import { X, Copy, Check, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ReceiveDialogProps {
  publicKey: string;
  onClose: () => void;
}

const ReceiveDialog = ({ publicKey, onClose }: ReceiveDialogProps) => {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    const fullAddress = `xrge:${publicKey}`;
    navigator.clipboard.writeText(fullAddress);
    setCopied(true);
    toast.success("Address copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  // Format with xrge prefix
  const fullAddress = `xrge:${publicKey}`;
  const displayKey = fullAddress.length > 45 
    ? `xrge:${publicKey.slice(0, 16)}...${publicKey.slice(-16)}`
    : fullAddress;

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

        <div className="space-y-6">
          {/* QR Placeholder */}
          <div className="aspect-square max-w-[200px] mx-auto bg-secondary rounded-xl flex items-center justify-center">
            <div className="text-center">
              <QrCode className="w-16 h-16 mx-auto mb-2 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">QR Code</p>
            </div>
          </div>

          {/* Address */}
          <div className="p-4 rounded-xl bg-secondary/50 border border-border">
            <p className="text-xs text-muted-foreground mb-2">Your Wallet Address</p>
            <p className="font-mono text-sm text-foreground break-all leading-relaxed">
              {displayKey}
            </p>
          </div>

          <Button onClick={copyAddress} className="w-full" variant="outline">
            {copied ? (
              <>
                <Check className="w-4 h-4 mr-2 text-success" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                Copy Full Address
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Share this address to receive XRGE tokens
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default ReceiveDialog;
