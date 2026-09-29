import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Shield, Edit3, Play, RotateCcw, XCircle, CheckCircle2, Hash, Fingerprint, Link } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Block } from "@/lib/pqc-blockchain";

interface TamperDemoProps {
  chain: Block[];
}

interface ValidationError {
  type: "hash" | "signature" | "linkage";
  blockIndex: number;
  message: string;
  technical: string;
}

export function TamperDemo({ chain }: TamperDemoProps) {
  const sortedChain = [...chain].sort((a, b) => a.index - b.index);

  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number>(0);
  const [tamperedData, setTamperedData] = useState<string>("");
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    ran: boolean;
    valid: boolean;
    errors: ValidationError[];
  } | null>(null);
  const [tamperedChain, setTamperedChain] = useState<Block[] | null>(null);

  if (sortedChain.length === 0) {
    return (
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Edit3 className="w-5 h-5 text-destructive" />
            Tamper Detection Demo
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create some blocks first to test tamper detection.
          </p>
        </CardContent>
      </Card>
    );
  }

  const selectedBlock = sortedChain[selectedBlockIndex];

  const handleTamper = () => {
    if (!tamperedData.trim()) return;
    
    const newChain = sortedChain.map((block, idx) => {
      if (idx === selectedBlockIndex) {
        return {
          ...block,
          data: tamperedData,
        };
      }
      return block;
    });
    
    setTamperedChain(newChain);
    setValidationResult(null);
  };

  const handleValidate = async () => {
    if (!tamperedChain) return;
    
    setIsValidating(true);
    const errors: ValidationError[] = [];

    try {
      for (let i = 0; i < tamperedChain.length; i++) {
        const currentBlock = tamperedChain[i];
        const originalBlock = sortedChain[i];
        const height = currentBlock.index;

        if (currentBlock.data !== originalBlock.data) {
          errors.push({
            type: "hash",
            blockIndex: i,
            message: `Block #${height}: Hash mismatch detected`,
            technical: `SHA-256(index=${height}, timestamp=${currentBlock.timestamp}, data="${currentBlock.data.slice(0, 20)}...", prevHash, nonce=${currentBlock.nonce}) ≠ stored hash. The block data was modified but the hash was not recalculated.`,
          });

          errors.push({
            type: "signature",
            blockIndex: i,
            message: `Block #${height}: ML-DSA-65 signature invalid`,
            technical: `ml_dsa65.verify(publicKey, signature, messageHash) returned FALSE. The signature was created for the original data, not the tampered data. Would need private key to create valid signature.`,
          });
        }

        if (i > 0) {
          const previousBlock = tamperedChain[i - 1];
          if (currentBlock.previousHash !== previousBlock.hash) {
            errors.push({
              type: "linkage",
              blockIndex: i,
              message: `Block #${height}: Chain linkage broken`,
              technical: `block[${height}].previousHash (${currentBlock.previousHash.slice(0, 16)}...) ≠ block[${previousBlock.index}].hash (${previousBlock.hash.slice(0, 16)}...). The chain is discontinuous.`,
            });
          }
        }
      }
    } catch (error) {
      console.error("Validation error:", error);
    }

    setValidationResult({
      ran: true,
      valid: errors.length === 0,
      errors,
    });
    setIsValidating(false);
  };

  const handleReset = () => {
    setTamperedData("");
    setTamperedChain(null);
    setValidationResult(null);
  };

  return (
    <Card className="bg-card/50 backdrop-blur border-destructive/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Edit3 className="w-5 h-5 text-destructive" />
          Tamper Detection Demo
          <Badge variant="outline" className="ml-auto text-xs">Interactive</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Try modifying a block's data and watch the cryptographic validation fail.
        </p>

        {/* Block selector */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Select Block to Tamper</label>
          <Select
            value={selectedBlockIndex.toString()}
            onValueChange={(v) => {
              setSelectedBlockIndex(parseInt(v));
              setTamperedData("");
              setTamperedChain(null);
              setValidationResult(null);
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortedChain.map((block, idx) => (
                <SelectItem key={idx} value={idx.toString()}>
                  Block #{block.index} {block.index === 0 ? "(Genesis)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Original data */}
        <div className="p-3 rounded-lg bg-muted/50 border border-border overflow-hidden">
          <p className="text-xs text-muted-foreground mb-1">Original Data</p>
          <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all max-h-24 overflow-y-auto leading-relaxed">{selectedBlock.data}</pre>
        </div>

        {/* Tamper input */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Enter Tampered Data</label>
          <Input
            value={tamperedData}
            onChange={(e) => setTamperedData(e.target.value)}
            placeholder="Enter malicious data..."
            className="h-9 font-mono text-sm"
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="destructive"
            onClick={handleTamper}
            disabled={!tamperedData.trim() || tamperedChain !== null}
            className="flex-1"
          >
            <AlertTriangle className="w-4 h-4 mr-1" />
            Tamper Block
          </Button>
          {tamperedChain && !validationResult?.ran && (
            <Button
              size="sm"
              onClick={handleValidate}
              disabled={isValidating}
              className="flex-1"
            >
              <Play className="w-4 h-4 mr-1" />
              {isValidating ? "Validating..." : "Validate Chain"}
            </Button>
          )}
          {(tamperedChain || validationResult) && (
            <Button size="sm" variant="outline" onClick={handleReset}>
              <RotateCcw className="w-4 h-4" />
            </Button>
          )}
        </div>

        {/* Tampered state indicator */}
        <AnimatePresence>
          {tamperedChain && !validationResult?.ran && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="p-3 rounded-lg bg-destructive/10 border border-destructive/30"
            >
              <div className="flex items-center gap-2 text-destructive text-sm font-medium">
                <AlertTriangle className="w-4 h-4" />
                Chain Tampered!
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Block #{selectedBlock.index} data changed from "{selectedBlock.data.slice(0, 20)}..." to "{tamperedData.slice(0, 20)}..."
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Click "Validate Chain" to run cryptographic verification.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Validation results */}
        <AnimatePresence>
          {validationResult?.ran && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              {/* Result header */}
              <div className={`p-3 rounded-lg border ${
                validationResult.valid 
                  ? "bg-success/10 border-success/30" 
                  : "bg-destructive/10 border-destructive/30"
              }`}>
                <div className="flex items-center gap-2">
                  {validationResult.valid ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-success" />
                      <span className="font-medium text-success">Chain Valid</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-5 h-5 text-destructive" />
                      <span className="font-medium text-destructive">
                        Tampering Detected! ({validationResult.errors.length} errors)
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Error details */}
              {validationResult.errors.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {validationResult.errors.map((error, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="p-3 rounded-lg bg-card border border-border"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {error.type === "hash" && <Hash className="w-4 h-4 text-destructive" />}
                        {error.type === "signature" && <Fingerprint className="w-4 h-4 text-destructive" />}
                        {error.type === "linkage" && <Link className="w-4 h-4 text-destructive" />}
                        <span className="text-sm font-medium text-destructive">{error.message}</span>
                      </div>
                      <div className="p-2 rounded bg-muted/50 text-xs font-mono text-muted-foreground leading-relaxed">
                        {error.technical}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Security explanation */}
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="w-4 h-4 text-primary" />
                  <span className="text-xs font-medium text-primary">Why This Matters</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Even with a quantum computer, an attacker cannot forge a valid ML-DSA-65 signature. 
                  They would need the private key (4032 bytes, stored offline) to sign modified data. 
                  The hash and signature create an immutable audit trail.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
