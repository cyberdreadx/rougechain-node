import { Shield, AlertTriangle, Cpu, Lock, Zap, Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export function QuantumThreatPanel() {
  return (
    <Card className="bg-card/50 backdrop-blur border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Cpu className="w-5 h-5 text-destructive" />
          The Quantum Threat
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Timeline */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Q-Day Timeline
            </span>
            <Badge variant="outline" className="text-destructive border-destructive/50">
              ~2030-2035
            </Badge>
          </div>
          <Progress value={65} className="h-2" />
          <p className="text-xs text-muted-foreground">
            Estimated time until quantum computers can break current encryption
          </p>
        </div>

        {/* Shor's Algorithm */}
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <span className="font-medium text-sm">Shor's Algorithm</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Quantum algorithm that can factor large integers exponentially faster than classical computers. 
            This breaks <span className="text-destructive font-medium">RSA</span> and <span className="text-destructive font-medium">ECDSA</span> — 
            the cryptography protecting most blockchains and internet security today.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Badge variant="secondary" className="text-xs bg-destructive/20 text-destructive">
              Bitcoin ⚠️
            </Badge>
            <Badge variant="secondary" className="text-xs bg-destructive/20 text-destructive">
              Ethereum ⚠️
            </Badge>
            <Badge variant="secondary" className="text-xs bg-destructive/20 text-destructive">
              TLS/HTTPS ⚠️
            </Badge>
          </div>
        </div>

        {/* Why Lattices are Safe */}
        <div className="p-3 rounded-lg bg-primary/10 border border-primary/20 space-y-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            <span className="font-medium text-sm">Why ML-DSA is Quantum-Safe</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            ML-DSA (Dilithium) uses <span className="text-primary font-medium">lattice-based cryptography</span> — 
            finding short vectors in high-dimensional lattices. Unlike factoring, 
            there's <span className="text-primary font-medium">no known quantum speedup</span> for this problem.
          </p>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="text-center p-2 rounded bg-background/50">
              <Zap className="w-4 h-4 mx-auto text-destructive mb-1" />
              <p className="text-[10px] text-muted-foreground">Classical</p>
              <p className="text-xs font-mono">2<sup>128</sup> ops</p>
            </div>
            <div className="text-center p-2 rounded bg-background/50">
              <Cpu className="w-4 h-4 mx-auto text-primary mb-1" />
              <p className="text-[10px] text-muted-foreground">Quantum</p>
              <p className="text-xs font-mono">2<sup>128</sup> ops</p>
            </div>
          </div>
          <p className="text-[10px] text-center text-muted-foreground">
            No quantum advantage — equally hard for both!
          </p>
        </div>

        {/* Your Protection */}
        <div className="flex items-center gap-2 p-2 rounded-lg bg-success/10 border border-success/30">
          <Lock className="w-4 h-4 text-success" />
          <div>
            <p className="text-xs font-medium text-success">RougeChain is Protected</p>
            <p className="text-[10px] text-muted-foreground">
              Using NIST-standardized ML-DSA-65 (FIPS 204)
            </p>
          </div>
        </div>

        {/* Fun Fact */}
        <div className="text-xs text-muted-foreground italic border-l-2 border-primary/30 pl-2">
          💡 IBM co-developed CRYSTALS-Dilithium while also building quantum computers — 
          creating both the threat and the solution!
        </div>
      </CardContent>
    </Card>
  );
}
