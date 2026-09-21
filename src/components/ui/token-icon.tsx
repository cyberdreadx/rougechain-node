import { useState } from "react";
import xrgeLogo from "@/assets/xrge-logo.webp";
import qethLogo from "@/assets/qeth-logo.png";
import qusdcLogo from "@/assets/qusdc-logo.png";

interface TokenIconProps {
  symbol: string;
  size?: number;
  imageUrl?: string | null;
  className?: string;
}

const BUILTIN_LOGOS: Record<string, string> = {
  XRGE: xrgeLogo,
  qETH: qethLogo,
  qUSDC: qusdcLogo,
};

export function TokenIcon({ symbol, size = 24, imageUrl, className = "" }: TokenIconProps) {
  const [imgError, setImgError] = useState(false);

  const src = BUILTIN_LOGOS[symbol] ?? (imgError ? null : imageUrl);

  if (src) {
    return (
      <img
        src={src}
        alt={symbol}
        className={`rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }

  const upper = symbol.toUpperCase();
  const isStablecoin = upper === "QUSDC";
  const isQbtc = upper === "QBTC";

  // qBTC: Bitcoin ₿ mark in orange.
  if (isQbtc) {
    return (
      <div
        className={`rounded-full flex items-center justify-center font-bold text-white ${className}`}
        style={{ width: size, height: size, backgroundColor: "#F7931A", fontSize: size * 0.6, lineHeight: 1 }}
      >
        ₿
      </div>
    );
  }

  return (
    <div
      className={`rounded-full flex items-center justify-center text-xs font-bold ${
        isStablecoin ? "bg-emerald-500/20 text-emerald-500" : "bg-primary/20"
      } ${className}`}
      style={{ width: size, height: size }}
    >
      {isStablecoin ? "$" : symbol.charAt(0)}
    </div>
  );
}
