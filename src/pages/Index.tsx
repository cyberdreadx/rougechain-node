import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Blocks, Wallet, MessageSquareLock, Shield, Atom, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: Wallet,
    title: "PQC Web Wallet",
    description: "Create a quantum-safe wallet, claim QBIT tokens, and send transactions signed with ML-DSA-65.",
    link: "/wallet",
    color: "primary",
  },
  {
    icon: Blocks,
    title: "Blockchain Explorer",
    description: "Mine blocks and explore the post-quantum blockchain with CRYSTALS-Dilithium signatures.",
    link: "/blockchain",
    color: "accent",
  },
  {
    icon: MessageSquareLock,
    title: "Secure Messenger",
    description: "End-to-end encrypted messaging with ML-KEM key exchange and quantum-safe signatures.",
    link: "/messenger",
    color: "success",
  },
];

const Index = () => {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-12">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-16"
        >
          <motion.div
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.1 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/30 mb-6"
          >
            <Atom className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium text-primary">Post-Quantum Cryptography</span>
          </motion.div>

          <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4">
            Quantum-Safe{" "}
            <span className="text-gradient-quantum">Blockchain</span>
          </h1>
          
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
            Experience the future of cryptography. Built with NIST-approved algorithms 
            to protect against quantum computing threats.
          </p>

          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link to="/wallet">
              <Button size="lg" className="gap-2">
                <Wallet className="w-5 h-5" />
                Open Wallet
              </Button>
            </Link>
            <Link to="/blockchain">
              <Button size="lg" variant="outline" className="gap-2">
                <Blocks className="w-5 h-5" />
                Explore Chain
              </Button>
            </Link>
          </div>
        </motion.div>

        {/* Feature Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-16">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + index * 0.1 }}
            >
              <Link to={feature.link}>
                <div className="group h-full p-6 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all duration-300 hover:shadow-lg hover:shadow-primary/5">
                  <div className={`w-12 h-12 rounded-xl bg-${feature.color}/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                    <feature.icon className={`w-6 h-6 text-${feature.color}`} />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        {/* Security Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5 border border-border p-8"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-bold text-foreground">Quantum Security Stack</h2>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-primary mb-2" />
              <h4 className="font-semibold text-foreground text-sm">ML-DSA-65</h4>
              <p className="text-xs text-muted-foreground">Digital signatures (Dilithium)</p>
            </div>
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-accent mb-2" />
              <h4 className="font-semibold text-foreground text-sm">ML-KEM-768</h4>
              <p className="text-xs text-muted-foreground">Key encapsulation (Kyber)</p>
            </div>
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-success mb-2" />
              <h4 className="font-semibold text-foreground text-sm">SHA-3</h4>
              <p className="text-xs text-muted-foreground">Quantum-resistant hashing</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mt-4 text-center">
            All algorithms are NIST FIPS 203/204 approved standards
          </p>
        </motion.div>
      </main>
    </div>
  );
};

export default Index;
