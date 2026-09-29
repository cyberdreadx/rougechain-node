import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "react-i18next";

/**
 * Layout-stable placeholders for the wallet page while its data loads (instead of a lone
 * spinner or misleading empty states). The pulse stops under prefers-reduced-motion
 * (see Skeleton).
 */

export const BalanceCardSkeleton = () => (
  <div className="relative overflow-hidden rounded-2xl bg-card p-6 border border-border" aria-hidden>
    <Skeleton className="h-7 w-44 rounded-full mb-6" />
    <Skeleton className="h-4 w-24 mb-2" />
    <Skeleton className="h-10 w-56 max-w-full mb-2" />
    <Skeleton className="h-5 w-28 mb-6" />
    <Skeleton className="h-16 w-full rounded-lg" />
  </div>
);

const Rows = ({ count }: { count: number }) => (
  <div className="divide-y divide-border">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Skeleton className="w-10 h-10 rounded-full shrink-0" />
          <div className="space-y-2 min-w-0 flex-1">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 pl-2">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      </div>
    ))}
  </div>
);

const SectionSkeleton = ({ title, count }: { title: string; count: number }) => (
  <div className="bg-card rounded-xl border border-border overflow-hidden" aria-hidden>
    <div className="px-4 py-3 border-b border-border">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    </div>
    <Rows count={count} />
  </div>
);

export const AssetListSkeleton = ({ count = 3 }: { count?: number }) => <SectionSkeleton title="Assets" count={count} />;

export const ActivitySkeleton = ({ count = 4 }: { count?: number }) => <SectionSkeleton title="Recent Activity" count={count} />;

/** Whole-page placeholder for the wallet's initial load. */
export const WalletPageSkeleton = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen" role="status" aria-busy="true" aria-label={t("common.loading")}>
      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <BalanceCardSkeleton />
        <div className="grid grid-cols-4 gap-2" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-md" />
          ))}
        </div>
        <AssetListSkeleton />
        <ActivitySkeleton />
      </main>
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
};
