import { Github, ExternalLink, BookOpen, Shield } from "lucide-react";

// X (formerly Twitter) logo
const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
import xrgeLogo from "@/assets/xrge-logo.webp";

export function Footer() {
  return (
    <footer className="border-t border-red-500/20 bg-black/40 backdrop-blur-sm mt-auto">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full" />
              <span className="font-bold text-lg text-white">RougeChain</span>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Post-quantum Layer 1 blockchain secured by ML-DSA-65 signatures.
            </p>
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-red-500/10 border border-red-500/30 w-fit">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-red-400 font-mono">TESTNET LIVE</span>
            </div>
          </div>

          {/* Resources */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Resources</h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://ai-integrations.gitbook.io/rougechain-post-quantum/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  Documentation
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/cyberdreadx/quantum-vault"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  <Github className="w-3.5 h-3.5" />
                  GitHub
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              </li>
            </ul>
          </div>

          {/* Trade */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Trade XRGE</h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=0x147120faec9277ec02d957584cfcd92b56a24317&chain0=8453&chain1=8453"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  Aerodrome (Base)
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              </li>
              <li>
                <a
                  href="https://www.geckoterminal.com/base/pools/0x059e10d26c64a63d04e1814f46305210eddc447d"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  GeckoTerminal
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              </li>
            </ul>
          </div>

          {/* Security */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Security</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-red-400" />
                ML-DSA-65 Signatures
              </li>
              <li className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-fuchsia-400" />
                ML-KEM-768 Key Exchange
              </li>
              <li className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
                NIST FIPS 203/204
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-8 pt-6 border-t border-red-500/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground/60 font-mono">
            RougeChain Testnet v0.1 • Post-Quantum Secured
          </p>
          <div className="flex items-center gap-4">
            <a
              href="https://x.com/rougecoin"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-red-400 transition-colors"
            >
              <XLogo className="w-4 h-4" />
            </a>
            <a
              href="https://github.com/cyberdreadx/quantum-vault"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-red-400 transition-colors"
            >
              <Github className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
