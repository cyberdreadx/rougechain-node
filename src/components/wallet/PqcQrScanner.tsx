import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Camera, CheckCircle2, AlertCircle, QrCode, Clipboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Html5Qrcode } from "html5-qrcode";

interface PqcQrScannerProps {
  onScan: (publicKey: string) => void;
  onClose: () => void;
}

// Convert base64 back to hex
const base64ToHex = (base64: string): string => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
};

const PqcQrScanner = ({ onScan, onClose }: PqcQrScannerProps) => {
  const [error, setError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [scannedParts, setScannedParts] = useState<Map<number, string>>(new Map());
  const [totalParts, setTotalParts] = useState<number | null>(null);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const mountedRef = useRef(true);
  const processingRef = useRef(false);

  // Handle successful scan completion
  const completeWithKey = useCallback(async (key: string) => {
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        if (state === 2 || state === 3) {
          await scannerRef.current.stop();
        }
      } catch (err) {
        console.log("Scanner stop error:", err);
      }
      scannerRef.current = null;
    }
    onScan(key);
  }, [onScan]);

  // Process scanned QR data
  const processQrData = useCallback((data: string) => {
    if (processingRef.current) return;
    if (data === lastScanned) return; // Prevent duplicate processing
    
    setLastScanned(data);
    console.log("QR Scanned:", data.substring(0, 50) + "...");

    // 1. Check for standard URL format
    if (data.includes("rougechain.io/wallet?addr=")) {
      const match = data.match(/addr=([a-fA-F0-9]+)/);
      if (match) {
        toast.success("Standard QR scanned - address preview found");
        // This is just a preview, show manual input for full key
        setShowManualInput(true);
        toast.info("Paste full address to continue", { duration: 3000 });
        return;
      }
    }

    // 2. Check for PQC-QR format: XRGE:1/3:base64data
    const pqcMatch = data.match(/^XRGE:(\d+)\/(\d+):(.+)$/);
    if (pqcMatch) {
      const part = parseInt(pqcMatch[1], 10);
      const total = parseInt(pqcMatch[2], 10);
      const partData = pqcMatch[3];
      
      processingRef.current = true;
      
      setTotalParts(total);
      setScannedParts(prev => {
        if (prev.has(part)) {
          processingRef.current = false;
          return prev;
        }
        
        const newParts = new Map(prev);
        newParts.set(part, partData);
        
        toast.success(`Part ${part}/${total} scanned!`, { duration: 1500 });
        
        // Check if complete
        if (newParts.size === total) {
          const sorted = Array.from(newParts.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, d]) => d);
          const fullBase64 = sorted.join("");
          const hexKey = base64ToHex(fullBase64);
          
          if (hexKey) {
            toast.success("Full address assembled!");
            setTimeout(() => completeWithKey(hexKey), 500);
          } else {
            toast.error("Failed to decode address");
          }
        }
        
        processingRef.current = false;
        return newParts;
      });
      return;
    }

    // 3. Check for raw hex (full public key)
    if (/^[a-fA-F0-9]{500,}$/.test(data)) {
      toast.success("Full address scanned!");
      completeWithKey(data);
      return;
    }

    // 4. Check for xrge: prefix
    if (data.toLowerCase().startsWith("xrge:")) {
      const key = data.slice(5);
      if (key.length >= 100) {
        toast.success("XRGE address scanned!");
        completeWithKey(key);
        return;
      }
    }

    // Unknown format - just show what we got
    console.log("Unknown QR format:", data);
  }, [lastScanned, completeWithKey]);

  useEffect(() => {
    mountedRef.current = true;
    let scanner: Html5Qrcode | null = null;
    
    const initScanner = async () => {
      try {
        // Get available cameras
        const devices = await Html5Qrcode.getCameras();
        console.log("Cameras found:", devices.length, devices);
        
        if (!devices || devices.length === 0) {
          throw new Error("No cameras found");
        }

        scanner = new Html5Qrcode("pqc-qr-reader", { verbose: true });
        scannerRef.current = scanner;

        // Use back camera if available, otherwise use facingMode
        const backCamera = devices.find(d => 
          d.label.toLowerCase().includes("back") || 
          d.label.toLowerCase().includes("rear") ||
          d.label.toLowerCase().includes("environment")
        );

        const cameraConfig = backCamera 
          ? backCamera.id 
          : { facingMode: "environment" };

        console.log("Using camera:", cameraConfig);

        await scanner.start(
          cameraConfig,
          {
            fps: 15,
            qrbox: { width: 200, height: 200 },
            aspectRatio: 1,
            disableFlip: false,
          },
          (decodedText) => {
            console.log("✓ QR DECODED:", decodedText.substring(0, 80));
            processQrData(decodedText);
          },
          (errorMessage) => {
            // Only log occasionally to avoid spam
            if (Math.random() < 0.01) {
              console.log("Scanning...", errorMessage.substring(0, 30));
            }
          }
        );

        if (mountedRef.current) {
          setCameraReady(true);
          console.log("Scanner started successfully");
        }
      } catch (err) {
        console.error("Scanner init error:", err);
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Camera not available");
          setShowManualInput(true);
        }
      }
    };

    // Delay to ensure DOM element exists
    const timer = setTimeout(initScanner, 300);

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      if (scanner) {
        try {
          const state = scanner.getState();
          if (state === 2 || state === 3) {
            scanner.stop().catch(() => {});
          }
        } catch {
          // Scanner may not be initialized yet
        }
      }
    };
  }, [processQrData]);

  const handleClose = async () => {
    // Stop the scanner first before closing
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        // Only stop if scanning or paused
        if (state === 2 || state === 3) { // 2 = SCANNING, 3 = PAUSED
          await scannerRef.current.stop();
        }
      } catch (err) {
        console.log("Scanner stop error:", err);
      }
      scannerRef.current = null;
    }
    onClose();
  };

  const handleManualSubmit = () => {
    const input = manualInput.trim();
    if (!input) {
      toast.error("Please enter an address");
      return;
    }
    
    const key = input.replace(/^xrge:/i, "");
    if (key.length >= 100) {
      completeWithKey(key);
    } else {
      toast.error("Address too short - please enter the full public key");
    }
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
      {/* Header */}
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="flex items-center justify-between p-4 border-b border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <QrCode className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Scan QR Code</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={handleClose}>
          <X className="w-5 h-5" />
        </Button>
      </motion.div>

      <div
        className="flex-1 flex flex-col items-center justify-center p-4 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Manual Input (shown as fallback or alongside camera) */}
        {showManualInput && (
          <div className="w-full max-w-[320px] mb-4 p-4 rounded-xl bg-card border border-border">
            <p className="text-sm font-medium mb-2">Or paste address manually:</p>
            <div className="flex gap-2">
              <Input
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="xrge:... or full public key"
                className="text-xs font-mono flex-1"
              />
              <Button size="sm" onClick={handleManualSubmit}>
                <Clipboard className="w-4 h-4" />
              </Button>
            </div>
            {error && (
              <p className="text-xs text-amber-600 mt-2">Camera: {error}</p>
            )}
          </div>
        )}

        {/* Error state without camera */}
        {error && !showManualInput ? (
          <div className="text-center space-y-4">
            <AlertCircle className="w-16 h-16 mx-auto text-destructive" />
            <p className="text-destructive font-medium">{error}</p>
            <div className="flex gap-2 justify-center">
              <Button onClick={() => setShowManualInput(true)} variant="outline">
                Enter Manually
              </Button>
              <Button onClick={handleClose}>Close</Button>
            </div>
          </div>
        ) : (
          <>
            {/* Camera View */}
            <div className="relative w-full max-w-[320px] aspect-square rounded-xl overflow-hidden bg-black">
              <div id="pqc-qr-reader" className="w-full h-full" />
              
              {!cameraReady && !error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <div className="text-center text-white">
                    <Camera className="w-12 h-12 mx-auto mb-2 animate-pulse" />
                    <p className="text-sm">Starting camera...</p>
                  </div>
                </div>
              )}
              
              {/* Corner brackets overlay */}
              {cameraReady && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-8 left-8 w-10 h-10 border-t-3 border-l-3 border-primary rounded-tl-lg" style={{ borderWidth: '3px' }} />
                  <div className="absolute top-8 right-8 w-10 h-10 border-t-3 border-r-3 border-primary rounded-tr-lg" style={{ borderWidth: '3px' }} />
                  <div className="absolute bottom-8 left-8 w-10 h-10 border-b-3 border-l-3 border-primary rounded-bl-lg" style={{ borderWidth: '3px' }} />
                  <div className="absolute bottom-8 right-8 w-10 h-10 border-b-3 border-r-3 border-primary rounded-br-lg" style={{ borderWidth: '3px' }} />
                </div>
              )}
            </div>

            {/* Multi-part progress */}
            {totalParts && totalParts > 1 && (
              <div className="mt-4 w-full max-w-[320px]">
                <p className="text-sm text-center text-muted-foreground mb-2">
                  Scanning multi-part PQC-QR...
                </p>
                <div className="flex justify-center gap-2 flex-wrap">
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
                  ? "Point at next QR code"
                  : "Point camera at QR code"}
              </p>
              {!showManualInput && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setShowManualInput(true)}
                  className="text-xs mt-1"
                >
                  Or paste address manually
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
};

export default PqcQrScanner;
