import { useEffect, useState } from "react";
import xrgeLogo from "@/assets/xrge-logo.webp";
import qethLogo from "@/assets/qeth-logo.png";
import qusdcLogo from "@/assets/qusdc-logo.png";
import { monogramFor } from "@/lib/token-visual";
import { cn } from "@/lib/utils";

interface TokenIconProps {
  symbol: string;
  size?: number;
  /** On-chain metadata image (from useTokenMetadata().getTokenImage). Ignored for built-in logos. */
  imageUrl?: string | null;
  className?: string;
}

/** Keyed by upper-case symbol so "qeth" / "QETH" / "qETH" all resolve. */
const BUILTIN_LOGOS: Record<string, string> = {
  XRGE: xrgeLogo,
  QETH: qethLogo,
  QUSDC: qusdcLogo,
};

/**
 * Token avatar: built-in logo for XRGE/qETH/qUSDC, a vector ₿ for qBTC, the token's metadata
 * image when it has one, else a deterministic brand-gradient monogram.
 */
export function TokenIcon({ symbol, size = 24, imageUrl, className = "" }: TokenIconProps) {
  const [imgError, setImgError] = useState(false);
  // A new URL deserves a fresh attempt (metadata often arrives after first render).
  useEffect(() => setImgError(false), [imageUrl]);

  const upper = (symbol ?? "").toUpperCase();
  const builtin = BUILTIN_LOGOS[upper];
  const src = builtin ?? (imgError ? null : imageUrl);
  const box = { width: size, height: size };

  if (src) {
    return (
      <img
        src={src}
        alt={symbol}
        loading="lazy"
        className={cn("token-icon rounded-full object-cover bg-muted/40", className)}
        style={box}
        onError={() => setImgError(true)}
      />
    );
  }

  if (upper === "QBTC") {
    return (
      <svg
        role="img"
        aria-label={symbol}
        viewBox="0 0 100 100"
        className={cn("token-icon rounded-full shrink-0", className)}
        style={box}
      >
        <circle cx="50" cy="50" r="50" fill="#F7931A" />
        <text x="50" y="71" fontSize="62" fontWeight="700" fill="#fff" textAnchor="middle" fontFamily="system-ui, sans-serif">
          ₿
        </text>
      </svg>
    );
  }

  const m = monogramFor(symbol);
  return (
    <div
      role="img"
      aria-label={symbol}
      className={cn("token-icon token-monogram rounded-full flex items-center justify-center shrink-0 font-bold text-white", className)}
      style={{
        ...box,
        backgroundImage: `linear-gradient(${m.angle}deg, ${m.from}, ${m.to})`,
        fontSize: Math.max(8, Math.round(size * (m.letters.length > 1 ? 0.36 : 0.46))),
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true">{m.letters}</span>
    </div>
  );
}
