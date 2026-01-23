import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Shield, Blocks, RotateCcw, CheckCircle2, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import BlockchainVisualizer from "@/components/blockchain/BlockchainVisualizer";
import MiningPanel from "@/components/blockchain/MiningPanel";
import PQCInfo from "@/components/blockchain/PQCInfo";
import { QuantumThreatPanel } from "@/components/blockchain/QuantumThreatPanel";
import { TamperDemo } from "@/components/blockchain/TamperDemo";
import GlobalNetworkGlobe from "@/components/blockchain/GlobalNetworkGlobe";
import type { Block, Keypair, CryptoInfo } from "@/lib/pqc-blockchain";
import { loadChain, resetChain, validateChain } from "@/lib/pqc-blockchain";
import xrgeLogo from "@/assets/xrge-logo.webp";

const Blockchain = () => {
  const [chain, setChain] = useState<Block[]>([]);
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [cryptoInfo, setCryptoInfo] = useState<CryptoInfo | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [chainValidity, setChainValidity] = useState<{ valid: boolean; checked: boolean }>({ valid: true, checked: false });
  const [isLoading, setIsLoading] = useState(true);

  // Load chain from database on mount
  useEffect(() => {
    const fetchChain = async () => {
      try {
        const savedChain = await loadChain();
        setChain(savedChain);
      } catch (error) {
        console.error("Failed to load chain:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchChain();
  }, []);

  const handleGenesisCreated = (block: Block, kp: Keypair, crypto?: CryptoInfo) => {
    setChain([block]);
    setKeypair(kp);
    if (crypto) setCryptoInfo(crypto);
    setChainValidity({ valid: true, checked: false });
  };

  const handleBlockMined = (block: Block) => {
    setChain((prev) => [...prev, block]);
    setChainValidity({ valid: true, checked: false });
  };

  const handleValidateChain = async () => {
    if (chain.length === 0) return;
    
    setIsValidating(true);
    try {
      const result = await validateChain(chain);
      setChainValidity({ valid: result.valid, checked: true });
      
      if (result.valid) {
        toast.success("Chain validated!", {
          description: `All ${chain.length} blocks verified with ML-DSA-65`,
        });
      } else {
        toast.error("Chain validation failed!", {
          description: result.errors.join(", "),
        });
      }
    } catch (error) {
      toast.error("Validation error");
    } finally {
      setIsValidating(false);
    }
  };

  const handleResetChain = async () => {
    try {
      await resetChain();
      setChain([]);
      setKeypair(null);
      setCryptoInfo(null);
      setChainValidity({ valid: true, checked: false });
      toast.success("Blockchain reset");
    } catch (error) {
      toast.error("Failed to reset chain");
    }
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-50 flex items-center justify-between px-4 py-4 border-b border-border bg-card/50 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full" />
            <div>
              <h1 className="text-lg font-bold text-foreground">RougeChain Explorer</h1>
              <p className="text-xs text-muted-foreground">ML-DSA-65 Signatures</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {chain.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleValidateChain}
                disabled={isValidating}
                className="hidden sm:flex"
              >
                {chainValidity.checked ? (
                  chainValidity.valid ? (
                    <CheckCircle2 className="w-4 h-4 mr-1 text-success" />
                  ) : (
                    <XCircle className="w-4 h-4 mr-1 text-destructive" />
                  )
                ) : (
                  <Shield className="w-4 h-4 mr-1" />
                )}
                {isValidating ? "Verifying..." : "Verify Chain"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetChain}
                className="text-muted-foreground hover:text-destructive"
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
            </>
          )}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border">
            <Shield className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground">ML-DSA-65</span>
          </div>
        </div>
      </motion.header>

      {/* Main content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 py-6">
        {/* Global Network Globe - First thing visible */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <GlobalNetworkGlobe className="h-[500px]" />
        </motion.div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            >
              <Blocks className="w-8 h-8 text-primary" />
            </motion.div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Chain visualization - spans 3 columns */}
            <div className="lg:col-span-3">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-card rounded-xl border border-border p-4"
              >
                <BlockchainVisualizer chain={chain} isValidating={isValidating} />
              </motion.div>

              {/* Stats */}
              {chain.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4"
                >
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Total Blocks</p>
                    <p className="text-2xl font-bold text-foreground">{chain.length}</p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Chain Valid</p>
                    <p className="text-2xl font-bold text-success">
                      {chainValidity.checked ? (chainValidity.valid ? "✓" : "✗") : "—"}
                    </p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Signature Algo</p>
                    <p className="text-sm font-medium text-primary">ML-DSA-65</p>
                    <p className="text-[10px] text-muted-foreground">FIPS 204</p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Security Level</p>
                    <p className="text-sm font-medium text-foreground">NIST L3</p>
                    <p className="text-[10px] text-muted-foreground">192-bit classical</p>
                  </div>
                </motion.div>
              )}

              {/* Crypto info banner */}
              {cryptoInfo && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mt-4 p-4 rounded-xl bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-5 h-5 text-primary" />
                    <span className="font-semibold text-foreground">Real Post-Quantum Cryptography Active</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                    <div>
                      <p className="text-muted-foreground">Algorithm</p>
                      <p className="text-foreground font-mono">{cryptoInfo.algorithm}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Standard</p>
                      <p className="text-foreground font-mono">{cryptoInfo.standard}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Public Key</p>
                      <p className="text-foreground font-mono">{cryptoInfo.publicKeySize}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Signature</p>
                      <p className="text-foreground font-mono">{cryptoInfo.signatureSize}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <MiningPanel
                chain={chain}
                keypair={keypair}
                onBlockMined={handleBlockMined}
                onKeypairGenerated={setKeypair}
                onGenesisCreated={handleGenesisCreated}
              />
              <TamperDemo chain={chain} />
              <QuantumThreatPanel />
              <PQCInfo />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Blockchain;
