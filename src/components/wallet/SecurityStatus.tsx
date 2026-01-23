import { motion } from "framer-motion";
import { Shield, Lock, Fingerprint, Key } from "lucide-react";

const securityFeatures = [
  {
    icon: Shield,
    name: "CRYSTALS-Dilithium",
    status: "Active",
    description: "Post-quantum digital signatures",
  },
  {
    icon: Lock,
    name: "CRYSTALS-Kyber",
    status: "Active",
    description: "Quantum-safe key encapsulation",
  },
  {
    icon: Fingerprint,
    name: "SPHINCS+",
    status: "Active",
    description: "Hash-based signatures backup",
  },
  {
    icon: Key,
    name: "Hardware Binding",
    status: "Enabled",
    description: "Secure element integration",
  },
];

const SecurityStatus = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            className="w-5 h-5 text-primary"
          >
            <Shield className="w-5 h-5" />
          </motion.div>
          <h3 className="text-sm font-semibold text-foreground">Quantum Security</h3>
          <span className="ml-auto px-2 py-0.5 text-xs rounded-full bg-success/20 text-success border border-success/30">
            Protected
          </span>
        </div>
      </div>
      
      <div className="p-4 space-y-3">
        {securityFeatures.map((feature, index) => (
          <motion.div
            key={feature.name}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5 + index * 0.05 }}
            className="flex items-start gap-3 p-2 rounded-lg hover:bg-secondary/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <feature.icon className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">{feature.name}</p>
                <span className="text-xs text-success">{feature.status}</span>
              </div>
              <p className="text-xs text-muted-foreground">{feature.description}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Visual quantum indicator */}
      <div className="px-4 pb-4">
        <div className="relative h-2 bg-secondary rounded-full overflow-hidden">
          <motion.div
            initial={{ width: "0%" }}
            animate={{ width: "100%" }}
            transition={{ duration: 2, ease: "easeOut" }}
            className="absolute h-full bg-gradient-to-r from-primary via-accent to-primary rounded-full"
          />
          <motion.div
            animate={{ x: ["-100%", "200%"] }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="absolute h-full w-1/3 bg-gradient-to-r from-transparent via-foreground/20 to-transparent"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Quantum resistance: Maximum
        </p>
      </div>
    </motion.div>
  );
};

export default SecurityStatus;
