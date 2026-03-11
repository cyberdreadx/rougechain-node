import { useState } from "react";
import xrgeLogo from "@/assets/xrge-logo.webp";
import qethLogo from "@/assets/qeth-logo.png";

interface TokenIconProps {
  symbol: string;
  size?: number;
  imageUrl?: string | null;
  className?: string;
}

const BUILTIN_LOGOS: Record<string, string> = {
  XRGE: xrgeLogo,
  qETH: qethLogo,
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

  return (
    <div
      className={`rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold ${className}`}
      style={{ width: size, height: size }}
    >
      {symbol.charAt(0)}
    </div>
  );
}
