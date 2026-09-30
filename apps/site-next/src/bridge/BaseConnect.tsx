/** Connect / show the Base wallet used for deposits and claims. */
import { Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@rougechain/ui";
import type { BaseConnection } from "./useBaseConnection";

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function BaseConnect({ conn, chainLabel, chainId, compact = false }: { conn: BaseConnection; chainLabel: string; chainId: number; compact?: boolean }) {
  const { t } = useTranslation("bridge");
  if (conn.address) {
    return (
      <div className="bridge-connected">
        <span className="bridge-dot" aria-hidden="true" />
        <span className="mono">
          {conn.mode === "local" ? t("form.connectedLocal", { address: shortAddr(conn.address) }) : t("form.connectedAs", { address: shortAddr(conn.address) })}
        </span>
        <button type="button" className="inline-link" onClick={conn.disconnect}>
          {t("form.disconnect")}
        </button>
        {conn.wrongChain && (
          <p className="form-error" role="alert">
            {t("form.wrongChain", { actual: conn.walletChainId ?? t("unknownChain"), expected: chainId, chain: chainLabel })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="bridge-connect">
      {!compact && conn.discovered.length > 1 && (
        <div className="field">
          <span>{t("form.chooseWallet")}</span>
          <div className="chip-row" role="group" aria-label={t("form.chooseWallet")}>
            {conn.discovered.map((d) => (
              <button
                key={d.info.rdns}
                type="button"
                className={`chip bridge-wallet-chip ${conn.selectedRdns === d.info.rdns ? "active" : ""}`}
                aria-pressed={conn.selectedRdns === d.info.rdns}
                onClick={() => conn.select(d.info.rdns)}
              >
                {d.info.icon ? <img src={d.info.icon} alt="" width={16} height={16} /> : <Wallet size={14} aria-hidden="true" />}
                {d.info.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <Button variant="outline" type="button" disabled={conn.connecting} onClick={() => void conn.connectInjected()}>
        <Wallet size={16} aria-hidden="true" /> {t("form.connectWallet", { wallet: conn.walletName, chain: chainLabel })}
      </Button>
      {conn.localAvailable && (
        <>
          <Button variant="outline" type="button" className="bridge-local-button" onClick={conn.connectLocal}>
            <Wallet size={16} aria-hidden="true" /> {t("form.useLocal")}
          </Button>
          {!compact && <p className="form-hint">{t("form.useLocalHint")}</p>}
        </>
      )}
      {conn.error && (
        <p className="form-error" role="alert">
          {conn.error}
        </p>
      )}
    </div>
  );
}
