import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { OPEN_TOUR_EVENT, TOUR_SECTIONS, hasSeenTour, isOnboardingActive, markTourSeen } from "@/lib/tour";
import { hasWallet } from "@/lib/unified-wallet";
import { cn } from "@/lib/utils";

/**
 * First-run guided tour (Qwalla's OnboardingTour, for the site). Opens on the
 * OPEN_TOUR_EVENT (Settings "Replay", end of onboarding) and once on its own
 * for a wallet holder who has never seen it.
 */
export function TourHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState(1);

  useEffect(() => {
    const onOpen = () => { setPage(0); setDir(1); setOpen(true); };
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
  }, []);

  // Auto-open once for existing wallet holders on the wallet page.
  useEffect(() => {
    if (pathname !== "/wallet" || hasSeenTour()) return;
    const timer = window.setTimeout(() => {
      let walletPresent = false;
      try { walletPresent = hasWallet(); } catch { /* storage blocked */ }
      if (walletPresent && !isOnboardingActive() && !hasSeenTour()) {
        setPage(0);
        setOpen(true);
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  const close = useCallback(() => {
    markTourSeen();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") { setDir(1); setPage((p) => Math.min(p + 1, TOUR_SECTIONS.length - 1)); }
      if (e.key === "ArrowLeft") { setDir(-1); setPage((p) => Math.max(p - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const last = TOUR_SECTIONS.length - 1;
  const section = TOUR_SECTIONS[Math.min(page, last)];
  const Icon = section.icon;

  const next = () => {
    if (page >= last) close();
    else { setDir(1); setPage((p) => p + 1); }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="tour"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 backdrop-blur-md p-4"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={t("tour.title")}
        >
          <motion.div
            initial={{ scale: 0.94, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, y: 16 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            className="relative w-full max-w-md rounded-2xl bg-card/80 backdrop-blur-xl border border-border/60 gradient-ring hud-corners p-6 sm:p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <span className="hud-label">{t("tour.step", { current: page + 1, total: TOUR_SECTIONS.length })}</span>
              <button
                type="button"
                onClick={close}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("tour.skip")} <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="relative min-h-[260px] overflow-hidden">
              <AnimatePresence mode="wait" custom={dir} initial={false}>
                <motion.div
                  key={section.id}
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -40 }}
                  transition={{ duration: 0.22 }}
                  className="flex flex-col items-center text-center gap-4"
                >
                  <div className="action-chip !w-20 !h-20 bg-gradient-to-br from-primary to-accent shadow-[0_0_30px_hsl(var(--primary)/0.35)]">
                    <Icon className="w-9 h-9" />
                  </div>
                  <h2 className="text-2xl font-bold text-shimmer">{t(`tour.sections.${section.id}.title`)}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line text-left sm:text-center">
                    {t(`tour.sections.${section.id}.body`)}
                  </p>
                  {section.to && section.to !== pathname && (
                    <button
                      type="button"
                      onClick={() => { close(); navigate(section.to!); }}
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                    >
                      {t("tour.open")} <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex justify-center gap-1.5 py-5">
              {TOUR_SECTIONS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  aria-label={t(`tour.sections.${s.id}.title`)}
                  onClick={() => { setDir(i > page ? 1 : -1); setPage(i); }}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === page ? "w-6 bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" : "w-1.5 bg-border hover:bg-muted-foreground",
                  )}
                />
              ))}
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                className="flex-1"
                disabled={page === 0}
                onClick={() => { setDir(-1); setPage((p) => Math.max(0, p - 1)); }}
              >
                {t("tour.back")}
              </Button>
              <Button className="flex-[2]" onClick={next}>
                {page >= last ? t("tour.done") : t("tour.next")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default TourHost;
