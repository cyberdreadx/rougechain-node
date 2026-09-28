import { useState } from "react";
import { useTranslation } from "react-i18next";
import AerodromeSwap from "@/components/buy/AerodromeSwap";
import { Copy, Check, ExternalLink, ShieldCheck, Coins, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const XRGE_BASE = "0x147120faEC9277ec02d957584CFCD92B56A24317";
const AERODROME = `https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=${XRGE_BASE}&chain0=8453&chain1=8453`;
const BASESCAN = `https://basescan.org/token/${XRGE_BASE}`;


export default function Buy() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(XRGE_BASE); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="text-center mb-6">
        <h1 className="text-3xl font-semibold flex items-center justify-center gap-2"><Coins className="w-7 h-7 text-primary" /> {t("buy.title")}</h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-2xl mx-auto">{t("buy.subtitle")}</p>
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="flex justify-center"><AerodromeSwap /></div>
        <div className="space-y-4">
          <Card><CardContent className="p-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> {t("buy.contractLabel")}</div>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono break-all">{XRGE_BASE}</code>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={copy} aria-label="copy">{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("buy.contractNote")} <a className="text-primary hover:underline" href={BASESCAN} target="_blank" rel="noopener noreferrer">Basescan <ExternalLink className="inline w-3 h-3" /></a></p>
          </CardContent></Card>
          <Card><CardContent className="p-4 space-y-2 text-sm">
            <div className="font-medium">{t("buy.howTitle")}</div>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs">
              <li>{t("buy.step1")}</li><li>{t("buy.step2")}</li><li>{t("buy.step3")}</li><li>{t("buy.step4")}</li>
            </ol>
          </CardContent></Card>
          <Card><CardContent className="p-4 space-y-3 text-xs">
            <div className="font-medium text-sm">{t("buy.altTitle")}</div>
            <a href={AERODROME} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">{t("buy.aerodrome")} <ExternalLink className="w-3 h-3" /></a>
            <a href="/bridge" className="flex items-center gap-1 text-primary hover:underline">{t("buy.bridge")}</a>
            <p className="text-muted-foreground flex items-start gap-1"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{t("buy.disclaimer")}</span></p>
          </CardContent></Card>
        </div>
      </div>
    </div>
  );
}
