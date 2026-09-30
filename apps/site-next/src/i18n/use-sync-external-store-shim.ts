// react-i18next imports the use-sync-external-store CJS shim. React 19 has the hook built in, so
// vite.config.ts aliases the shim here: no shim code in the bundle, and in tests no binding to the
// repo root's React 18 (the shim is hoisted next to apps/web's React).
export { useSyncExternalStore } from "react";
