import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, Check, Shield, Share2, ChevronLeft, ChevronRight, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { toDataURL } from "qrcode";

interface ReceiveDialogProps {
  publicKey: string;
  onClose: () => void;
}

// Convert hex to base64 for more compact encoding
const hexToBase64 = (hex: string): string => {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  return btoa(String.fromCharCode(...bytes));
};

// Split data into chunks for multi-part QR
const splitForQR = (data: string, maxChunkSize: number = 1200): string[] => {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += maxChunkSize) {
    chunks.push(data.slice(i, i + maxChunkSize));
  }
  return chunks;
};

const ReceiveDialog = ({ publicKey, onClose }: ReceiveDialogProps) => {
  const [copied, setCopied] = useState(false);
  const [currentQrIndex, setCurrentQrIndex] = useState(0);
  const [qrCodes, setQrCodes] = useState<string[]>([]);
  const [qrError, setQrError] = useState(false);
  const [simpleQr, setSimpleQr] = useState<string | null>(null);
  const [showSimpleQr, setShowSimpleQr] = useState(true); // Default to simple QR

  // Format with xrge prefix
  const fullAddress = `xrge:${publicKey}`;
  const displayKey = `xrge:${publicKey.slice(0, 20)}...${publicKey.slice(-20)}`;
  
  // Create a short fingerprint of the key for verification
  const keyFingerprint = publicKey.slice(0, 8) + "..." + publicKey.slice(-8);

  // Generate simple QR (URL that opens wallet with address reference)
  useEffect(() => {
    const generateSimpleQR = async () => {
      try {
        // Simple QR contains a URL to the XRGE app/site with a key fingerprint
        // This is scannable by any phone and provides a way to verify
        const simpleData = `https://rougechain.io/wallet?addr=${publicKey.slice(0, 32)}`;
        const qr = await toDataURL(simpleData, {
          width: 200,
          margin: 2,
          errorCorrectionLevel: "M",
          color: {
            dark: "#000000",
            light: "#ffffff",
          },
        });
        setSimpleQr(qr);
      } catch (err) {
        console.error("Simple QR error:", err);
      }
    };
    generateSimpleQR();
  }, [publicKey]);

  // Generate multi-part PQC-QR codes
  useEffect(() => {
    const generateQRCodes = async () => {
      try {
        // Convert to base64 for more compact encoding
        const base64Key = hexToBase64(publicKey);
        const chunks = splitForQR(base64Key, 1000);
        const totalParts = chunks.length;
        
        const qrPromises = chunks.map(async (chunk, index) => {
          // Format: XRGE:part/total:data
          const qrData = `XRGE:${index + 1}/${totalParts}:${chunk}`;
          return await toDataURL(qrData, {
            width: 200,
            margin: 1,
            errorCorrectionLevel: "M",
            color: {
              dark: "#000000",
              light: "#ffffff",
            },
          });
        });
        
        const codes = await Promise.all(qrPromises);
        setQrCodes(codes);
      } catch (err) {
        console.error("QR generation error:", err);
        setQrError(true);
      }
    };
    
    generateQRCodes();
  }, [publicKey]);

  const copyAddress = () => {
    navigator.clipboard.writeText(fullAddress);
    setCopied(true);
    toast.success("Address copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const shareAddress = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "My XRGE Wallet Address",
          text: fullAddress,
        });
      } catch (err) {
        // User cancelled or share failed
        if ((err as Error).name !== "AbortError") {
          copyAddress(); // Fall back to copy
        }
      }
    } else {
      copyAddress(); // Fall back to copy
    }
  };

  const nextQr = () => setCurrentQrIndex((i) => (i + 1) % qrCodes.length);
  const prevQr = () => setCurrentQrIndex((i) => (i - 1 + qrCodes.length) % qrCodes.length);

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
          {/* QR Mode Toggle */}
          <div className="flex items-center justify-center gap-2 p-1 rounded-lg bg-muted/50">
            <button
              onClick={() => setShowSimpleQr(true)}
              className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                showSimpleQr ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
              }`}
            >
              Standard QR
            </button>
            <button
              onClick={() => setShowSimpleQr(false)}
              className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                !showSimpleQr ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
              }`}
            >
              PQC-QR ({qrCodes.length} parts)
            </button>
          </div>

          {/* Simple QR Mode */}
          {showSimpleQr && simpleQr ? (
            <div className="relative">
              <div className="bg-white rounded-xl p-3 mx-auto max-w-[200px]">
                <img
                  src={simpleQr}
                  alt="XRGE QR Code"
                  className="w-full h-auto rounded-lg"
                />
              </div>
              
              <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border">
                <p className="text-[11px] text-muted-foreground text-center">
                  <span className="font-medium text-foreground">Scan to verify:</span> Opens rougechain.io with address preview
                </p>
                <p className="text-[10px] text-muted-foreground text-center mt-1">
                  Fingerprint: <span className="font-mono">{keyFingerprint}</span>
                </p>
              </div>
            </div>
          ) : qrCodes.length > 0 && !qrError ? (
            /* PQC-QR Mode */
            <div className="relative">
              {/* QR Code Display */}
              <div className="bg-white rounded-xl p-3 mx-auto max-w-[220px]">
                <AnimatePresence mode="wait">
                  <motion.img
                    key={currentQrIndex}
                    src={qrCodes[currentQrIndex]}
                    alt={`PQC-QR Part ${currentQrIndex + 1}`}
                    className="w-full h-auto rounded-lg"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  />
                </AnimatePresence>
              </div>
              
              {/* Part indicator - below QR */}
              <div className="text-center mt-2">
                <span className="bg-primary/10 text-primary text-xs px-3 py-1 rounded-full">
                  Part {currentQrIndex + 1} of {qrCodes.length}
                </span>
              </div>

              {/* Navigation arrows */}
              {qrCodes.length > 1 && (
                <div className="flex items-center justify-between mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={prevQr}
                    className="h-8 px-2"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Prev
                  </Button>
                  
                  {/* Dot indicators */}
                  <div className="flex gap-1.5">
                    {qrCodes.map((_, i) => (
                      <button
                        key={i}
                        onClick={() => setCurrentQrIndex(i)}
                        className={`w-2 h-2 rounded-full transition-colors ${
                          i === currentQrIndex ? "bg-primary" : "bg-muted-foreground/30"
                        }`}
                      />
                    ))}
                  </div>
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={nextQr}
                    className="h-8 px-2"
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              )}

              {/* PQC-QR Info */}
              <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-[11px] text-amber-700 dark:text-amber-400 text-center">
                  <span className="font-medium">PQC-QR:</span> Requires XRGE wallet scanner to decode
                </p>
                <p className="text-[10px] text-muted-foreground text-center mt-1">
                  Contains full quantum-safe public key
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 p-4 rounded-xl bg-muted/50">
              <Shield className="w-5 h-5 text-primary" />
              <div className="text-center">
                <p className="text-sm font-medium text-primary">Post-Quantum Address</p>
                <p className="text-[10px] text-muted-foreground">ML-DSA-65 (CRYSTALS-Dilithium)</p>
              </div>
            </div>
          )}

          {/* Address Display */}
          <div className="p-3 rounded-xl bg-secondary/50 border border-border">
            <p className="text-[10px] text-muted-foreground mb-1">Wallet Address</p>
            <p className="font-mono text-[11px] text-foreground break-all leading-relaxed select-all">
              {displayKey}
            </p>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={copyAddress} className="w-full" size="sm" variant={copied ? "default" : "outline"}>
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-1" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" />
                  Copy
                </>
              )}
            </Button>
            <Button onClick={shareAddress} className="w-full" size="sm" variant="outline">
              <Share2 className="w-4 h-4 mr-1" />
              Share
            </Button>
          </div>

          {/* Scan Instructions */}
          {!showSimpleQr && qrCodes.length > 1 && (
            <p className="text-[10px] text-muted-foreground text-center">
              Scan all {qrCodes.length} QR codes in order with an XRGE-compatible scanner
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

export default ReceiveDialog;
