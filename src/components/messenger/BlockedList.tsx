import { useEffect, useState } from "react";
import { Ban, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { WalletAvatar } from "@/components/WalletAvatar";
import { ChatSheet } from "./ChatSheet";
import { useMessengerPrefs } from "./useMessengerPrefs";
import { getWallets, type Wallet } from "@/lib/pqc-messenger";
import { unblockWalletKeys, walletKeys } from "@/lib/messenger-prefs";

/** Blocked wallets (Qwalla messenger/blocked.tsx): who's blocked on this device, with Unblock. */
export function BlockedList({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { blocked } = useMessengerPrefs();
  const [directory, setDirectory] = useState<Wallet[]>([]);

  useEffect(() => {
    getWallets().then(setDirectory).catch(() => setDirectory([]));
  }, []);

  const lookup = (key: string) => directory.find((w) => walletKeys(w).includes(key));

  const unblock = (key: string) => {
    const w = lookup(key);
    unblockWalletKeys(w ? [key, ...walletKeys(w)] : [key]);
    toast.success(t("chat.block.unblocked", { name: w?.displayName || t("chat.common.anonymous") }));
  };

  const keys = [...blocked];
  return (
    <ChatSheet title={t("chat.block.title")} icon={<Ban className="w-4 h-4 text-[hsl(var(--hologram))]" />} onClose={onClose}>
      {keys.length === 0 ? (
        <div className="flex flex-col items-center text-center gap-2 px-6 py-10">
          <ShieldCheck className="w-10 h-10 text-muted-foreground" />
          <p className="font-medium">{t("chat.block.emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("chat.block.emptyBody")}</p>
        </div>
      ) : (
        <div className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground mb-2">{t("chat.block.hint")}</p>
          {keys.map((key) => {
            const w = lookup(key);
            return (
              <div key={key} className="flex items-center gap-3 py-2">
                <WalletAvatar id={w?.id || key} uri={w?.avatarUrl} name={w?.displayName} size={36} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{w?.displayName || t("chat.common.anonymous")}</span>
                  <span className="block text-[11px] font-mono text-muted-foreground truncate">{key.slice(0, 24)}…</span>
                </span>
                <Button variant="outline" size="sm" onClick={() => unblock(key)}>{t("chat.block.unblock")}</Button>
              </div>
            );
          })}
        </div>
      )}
    </ChatSheet>
  );
}

export default BlockedList;
