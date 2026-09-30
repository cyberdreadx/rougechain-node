import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import type { FeatureArea } from "./types";

// Loaded on demand: the messenger / mail code (and its ML-KEM / media helpers) stays out of the
// landing bundle. Paths are apps/web's.
const MessengerPage = lazy(() => import("../messenger/MessengerPage"));
const MailPage = lazy(() => import("../mail/MailPage"));

function Loading() {
  return (
    <main id="main" className="app-main">
      <div className="container">
        <p className="muted">Loading…</p>
      </div>
    </main>
  );
}

/** Messenger and mail. Owner: the messenger/mail area. */
export const messengerArea: FeatureArea = {
  routes: [
    <Route
      key="messenger"
      path="/messenger"
      element={
        <Suspense fallback={<Loading />}>
          <MessengerPage />
        </Suspense>
      }
    />,
    <Route
      key="mail"
      path="/mail"
      element={
        <Suspense fallback={<Loading />}>
          <MailPage />
        </Suspense>
      }
    />,
  ],
  headerProduct: (pathname) => {
    if (pathname === "/messenger" || pathname.startsWith("/messenger/")) return "Messenger";
    if (pathname === "/mail" || pathname.startsWith("/mail/")) return "Mail";
    return null;
  },
};
