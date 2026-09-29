/**
 * Minimal app-wide toasts (no dependency). `toast.success("…")` works from anywhere, including
 * outside React; <Toaster /> renders them. Messages are text only — never put secrets in them.
 */
import { useEffect, useSyncExternalStore } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

const DURATION_MS = 5000;
const MAX_VISIBLE = 4;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(kind: ToastKind, title: string, opts?: { description?: string }): number {
  const id = nextId++;
  items = [...items, { id, kind, title, description: opts?.description }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string, opts?: { description?: string }) => push("success", title, opts),
  error: (title: string, opts?: { description?: string }) => push("error", title, opts),
  info: (title: string, opts?: { description?: string }) => push("info", title, opts),
};

/** Test helper. */
export function clearToasts(): void {
  items = [];
  emit();
}

function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
    () => items,
  );
}

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const id = window.setTimeout(() => dismissToast(item.id), DURATION_MS);
    return () => window.clearTimeout(id);
  }, [item.id]);
  const Icon = item.kind === "success" ? CheckCircle2 : item.kind === "error" ? TriangleAlert : Info;
  return (
    <div className={`toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div className="toast-body">
        <strong>{item.title}</strong>
        {item.description && <span>{item.description}</span>}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => dismissToast(item.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function Toaster() {
  const list = useToasts();
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
