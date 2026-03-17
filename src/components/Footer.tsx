import { Github, ExternalLink, BookOpen, Shield, Puzzle } from "lucide-react";

// X (formerly Twitter) logo
const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// Discord logo
const DiscordLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
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
                  href="https://github.com/cyberdreadx/rougechain-node"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  <Github className="w-3.5 h-3.5" />
                  GitHub
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </a>
              </li>
              <li>
                <a
                  href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  <Puzzle className="w-3.5 h-3.5" />
                  Chrome Extension
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
                  href="https://dexscreener.com/base/0x147120faec9277ec02d957584cfcd92b56a24317"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
                >
                  DexScreener
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
              title="Follow on X"
            >
              <XLogo className="w-4 h-4" />
            </a>
            <a
              href="https://discord.gg/Fn6CCrx8jP"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-red-400 transition-colors"
              title="Join Discord"
            >
              <DiscordLogo className="w-4 h-4" />
            </a>
            <a
              href="https://github.com/cyberdreadx/rougechain-node"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-red-400 transition-colors"
              title="View on GitHub"
            >
              <Github className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
