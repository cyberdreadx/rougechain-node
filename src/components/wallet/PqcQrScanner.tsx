import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { X, Camera, CheckCircle2, AlertCircle, QrCode, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Html5Qrcode } from "html5-qrcode";

interface PqcQrScannerProps {
  onScan: (publicKey: string) => void;
  onClose: () => void;
}

interface ScannedPart {
  part: number;
  total: number;
  data: string;
}

// Convert base64 back to hex
const base64ToHex = (base64: string): string => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Parse XRGE QR format: "XRGE:1/3:base64data" or simple URL format
const parseXrgeQr = (data: string): ScannedPart | { simpleAddress: string } | null => {
  // Check for simple URL format
  if (data.startsWith("https://rougechain.io/wallet?addr=")) {
    const addr = data.split("addr=")[1];
    return { simpleAddress: addr };
  }
  
  // Check for PQC-QR format: XRGE:1/3:data
  const match = data.match(/^XRGE:(\d+)\/(\d+):(.+)$/);
  if (match) {
    return {
      part: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
      data: match[3],
    };
  }
  
  // Check for raw hex public key (if someone just has the key)
  if (/^[a-fA-F0-9]{100,}$/.test(data)) {
    return { simpleAddress: data };
  }
  
  // Check for xrge: prefix format
  if (data.startsWith("xrge:")) {
    return { simpleAddress: data.slice(5) };
  }
  
  return null;
};

const PqcQrScanner = ({ onScan, onClose }: PqcQrScannerProps) => {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedParts, setScannedParts] = useState<Map<number, string>>(new Map());
  const [totalParts, setTotalParts] = useState<number | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    
    const initScanner = async () => {
      try {
        const scanner = new Html5Qrcode("pqc-qr-reader");
        scannerRef.current = scanner;
        
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          (decodedText) => {
            handleScan(decodedText);
          },
          () => {
            // QR code not found in frame - this is normal
          }
        );
        
        if (mounted) {
          setScanning(true);
          setCameraReady(true);
        }
      } catch (err) {
        console.error("Scanner init error:", err);
        if (mounted) {
          setError("Camera access denied or not available");
        }
      }
    };

    initScanner();

    return () => {
      mounted = false;
      if (scannerRef.current) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, []);

  const handleScan = (data: string) => {
    const parsed = parseXrgeQr(data);
    
    if (!parsed) {
      // Unknown format
      return;
    }
    
    // Simple address format (URL or raw key)
    if ("simpleAddress" in parsed) {
      toast.success("Address scanned!");
      stopAndReturn(parsed.simpleAddress);
      return;
    }
    
    // PQC-QR multi-part format
    const { part, total, data: partData } = parsed;
    
    // Set total parts if not set
    if (totalParts === null) {
      setTotalParts(total);
    } else if (totalParts !== total) {
      toast.error("Mixed QR codes detected", {
        description: "Please scan QR codes from the same address",
      });
      return;
    }
    
    // Add this part if not already scanned
    if (!scannedParts.has(part)) {
      const newParts = new Map(scannedParts);
      newParts.set(part, partData);
      setScannedParts(newParts);
      
      toast.success(`Part ${part}/${total} scanned!`, {
        duration: 1500,
      });
      
      // Check if we have all parts
      if (newParts.size === total) {
        // Assemble the full key
        const sortedParts = Array.from(newParts.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, d]) => d);
        const fullBase64 = sortedParts.join("");
        
        try {
          const hexKey = base64ToHex(fullBase64);
          toast.success("Full address assembled!");
          stopAndReturn(hexKey);
        } catch (err) {
          toast.error("Failed to decode address");
          console.error("Base64 decode error:", err);
        }
      }
    }
  };

  const stopAndReturn = async (publicKey: string) => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch (err) {
        console.error("Scanner stop error:", err);
      }
    }
    onScan(publicKey);
  };

  const handleClose = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch (err) {
        console.error("Scanner stop error:", err);
      }
    }
    onClose();
  };

  const partsArray = totalParts
    ? Array.from({ length: totalParts }, (_, i) => i + 1)
    : [];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col"
      onClick={handleClose}
    >
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="flex items-center justify-between p-4 border-b border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <QrCode className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">PQC-QR Scanner</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={handleClose}>
          <X className="w-5 h-5" />
        </Button>
      </motion.div>

      <div
        className="flex-1 flex flex-col items-center justify-center p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <div className="text-center space-y-4">
            <AlertCircle className="w-16 h-16 mx-auto text-destructive" />
            <p className="text-destructive font-medium">{error}</p>
            <Button onClick={handleClose}>Close</Button>
          </div>
        ) : (
          <>
            {/* Camera View */}
            <div
              ref={containerRef}
              className="relative w-full max-w-[300px] aspect-square rounded-xl overflow-hidden bg-black"
            >
              <div id="pqc-qr-reader" className="w-full h-full" />
              
              {!cameraReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <div className="text-center text-white">
                    <Camera className="w-12 h-12 mx-auto mb-2 animate-pulse" />
                    <p className="text-sm">Starting camera...</p>
                  </div>
                </div>
              )}
              
              {/* Scanning overlay */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-4 border-2 border-primary/50 rounded-lg" />
                <div className="absolute top-4 left-4 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl-lg" />
                <div className="absolute top-4 right-4 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr-lg" />
                <div className="absolute bottom-4 left-4 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl-lg" />
                <div className="absolute bottom-4 right-4 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br-lg" />
              </div>
            </div>

            {/* Progress for multi-part scan */}
            {totalParts && totalParts > 1 && (
              <div className="mt-4 w-full max-w-[300px]">
                <p className="text-sm text-center text-muted-foreground mb-2">
                  Scanning multi-part PQC-QR...
                </p>
                <div className="flex justify-center gap-2">
                  {partsArray.map((part) => (
                    <div
                      key={part}
                      className={`w-10 h-10 rounded-lg flex items-center justify-center border-2 transition-colors ${
                        scannedParts.has(part)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "bg-muted/50 border-border text-muted-foreground"
                      }`}
                    >
                      {scannedParts.has(part) ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <span className="text-sm font-medium">{part}</span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-center text-muted-foreground mt-2">
                  {scannedParts.size} of {totalParts} parts scanned
                </p>
              </div>
            )}

            {/* Instructions */}
            <div className="mt-4 text-center">
              <p className="text-sm text-muted-foreground">
                {totalParts
                  ? "Point camera at the next QR code"
                  : "Point camera at XRGE QR code"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Supports standard QR and multi-part PQC-QR
              </p>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
};

export default PqcQrScanner;
