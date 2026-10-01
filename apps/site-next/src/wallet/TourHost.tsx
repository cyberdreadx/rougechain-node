import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { hasWallet } from "@rougechain/core/unified-wallet";
import { OPEN_TOUR_EVENT, TOUR_SECTIONS, hasSeenTour, isOnboardingActive, markTourSeen } from "./tour";

/**
 * First-run tour (apps/web's TourHost): opens on OPEN_TOUR_EVENT (Settings "Replay", end of
 * onboarding) and once by itself on /wallet for a wallet holder who has never seen it.
 */
export function TourHost() {
  const { t } = useTranslation("wallet");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const onOpen = () => {
      setPage(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (pathname !== "/wallet" || hasSeenTour()) return;
    const id = window.setTimeout(() => {
      let present = false;
      try {
        present = hasWallet();
      } catch {
        /* storage blocked */
      }
      if (present && !isOnboardingActive() && !hasSeenTour()) {
        setPage(0);
        setOpen(true);
      }
    }, 1500);
    return () => window.clearTimeout(id);
  }, [pathname]);

  const close = useCallback(() => {
    markTourSeen();
    setOpen(false);
  }, []);

  const last = TOUR_SECTIONS.length - 1;
  const section = TOUR_SECTIONS[Math.min(page, last)];
  return (
    <Dialog open={open} onClose={close} title={t("tour.title")}>
      <div className="tour-body">
        <span className="mono muted">
          {t("tour.step", { current: page + 1, total: TOUR_SECTIONS.length })}
        </span>
        <h3>{t(`tour.sections.${section.id}.title`)}</h3>
        <p className="tour-text">{t(`tour.sections.${section.id}.body`)}</p>
        {section.to && section.to !== pathname && (
          <button
            type="button"
            className="inline-link"
            onClick={() => {
              close();
              navigate(section.to!);
            }}
          >
            {t("tour.open")} →
          </button>
        )}
        <div className="actions">
          <Button variant="ghost small" onClick={close}>
            {t("tour.skip")}
          </Button>
          {page > 0 && (
            <Button variant="outline small" onClick={() => setPage((p) => p - 1)}>
              {t("tour.back")}
            </Button>
          )}
          <Button variant="small" onClick={() => (page >= last ? close() : setPage((p) => p + 1))}>
            {page >= last ? t("tour.done") : t("tour.next")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
