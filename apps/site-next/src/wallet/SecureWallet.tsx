/**
 * Mandatory "secure your wallet" screen (SecureWalletGate): an unlocked wallet with private keys
 * that the password vault does not protect — a create / import whose password step was left, or a
 * legacy wallet an older build stored in plaintext. Setting the password encrypts it (core
 * lockUnifiedWallet, AES-256-GCM / PBKDF2 600k) and deletes the plaintext copy. Offers a backup
 * (recovery phrase / encrypted .pqcbackup) first.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@rougechain/ui";
import { useWallet } from "./WalletProvider";
import { NewPasswordForm } from "./Onboarding";
import { BackupDialog } from "./BackupDialog";
import { toast } from "./toast";

export default function SecureWallet() {
  const { t } = useTranslation("wallet");
  const { pending, flow, advanceFlow } = useWallet();
  const [backup, setBackup] = useState(false);
  return (
    <main id="main" className="app-main wallet-main">
      <div className="container">
        <NewPasswordForm
          header={
            <>
              <ShieldAlert size={22} aria-hidden="true" />
              <h2>{t("secure.title")}</h2>
              <p>{pending ? t("secure.pendingBody") : t("secure.legacyBody")}</p>
              <p className="notice warning">{t("secure.required")}</p>
              <div className="actions">
                <Button type="button" variant="outline small" onClick={() => setBackup(true)}>
                  {t("secure.backupFirst")}
                </Button>
              </div>
              <p className="form-hint">{t("secure.backupHint")}</p>
            </>
          }
          submitLabel={t("secure.submit")}
          onSecured={() => {
            toast.success(t("secure.done"), { description: t("secure.doneBody") });
            if (flow) advanceFlow("onboarding");
          }}
        />
      </div>
      {backup && <BackupDialog open onClose={() => setBackup(false)} allowImport={false} />}
    </main>
  );
}
