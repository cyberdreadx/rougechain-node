import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UiTextProvider } from "@rougechain/ui";

/** Strings rendered by @rougechain/ui itself (dialog close button, demo badge). */
export function UiText({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <UiTextProvider
      value={{
        closeDialog: t("ui.closeDialog"),
        designDemo: t("ui.designDemo"),
      }}
    >
      {children}
    </UiTextProvider>
  );
}
