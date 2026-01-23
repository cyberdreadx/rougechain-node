import { motion } from "framer-motion";
import { Shield, Atom, Lock, Cpu, ExternalLink } from "lucide-react";

const algorithms = [
  {
    name: "CRYSTALS-Dilithium",
    type: "Digital Signatures",
    description: "Lattice-based signatures resistant to Shor's algorithm",
    keySize: "2528 bytes public",
    sigSize: "2420 bytes",
    status: "NIST Approved",
    icon: Shield,
  },
  {
    name: "CRYSTALS-Kyber",
    type: "Key Encapsulation",
    description: "Module-LWE based key exchange",
    keySize: "1184 bytes public",
    sigSize: "1088 bytes ciphertext",
    status: "NIST Approved",
    icon: Lock,
  },
  {
    name: "SPHINCS+",
    type: "Hash-based Signatures",
    description: "Stateless hash-based signature scheme",
    keySize: "64 bytes public",
    sigSize: "~8000 bytes",
    status: "NIST Approved",
    icon: Atom,
  },
];

const PQCInfo = () => {
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Cpu className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Post-Quantum Cryptography</h3>
      </div>

      <div className="p-4 space-y-4">
        {/* Introduction */}
        <div className="p-3 rounded-lg bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="text-primary font-medium">Why PQC?</span> Quantum computers running 
            Shor's algorithm can break RSA and ECDSA. Post-quantum algorithms use lattice problems 
            that remain hard even for quantum computers.
          </p>
        </div>

        {/* Algorithm cards */}
        <div className="space-y-3">
          {algorithms.map((algo, index) => (
            <motion.div
              key={algo.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="p-3 rounded-lg bg-muted/50 border border-border hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                  <algo.icon className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-medium text-foreground">{algo.name}</p>
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-success/20 text-success">
                      {algo.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{algo.description}</p>
                  <div className="flex gap-4 text-[10px] text-muted-foreground">
                    <span>Key: {algo.keySize}</span>
                    <span>Sig: {algo.sigSize}</span>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Security level */}
        <div className="p-3 rounded-lg bg-secondary/50 border border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Security Level</span>
            <span className="text-xs text-primary font-medium">NIST Level 3</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: "75%" }}
              transition={{ duration: 1, delay: 0.5 }}
              className="h-full bg-gradient-to-r from-primary to-success"
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Equivalent to AES-192 classical security
          </p>
        </div>

        {/* Learn more link */}
        <a
          href="https://csrc.nist.gov/projects/post-quantum-cryptography"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-xs text-primary hover:underline"
        >
          <ExternalLink className="w-3 h-3" />
          Learn more about NIST PQC standards
        </a>
      </div>
    </div>
  );
};

export default PQCInfo;
