export const STORAGE_KEY = "rougechain-poc-explore-layout-v1";
const names = ["Network", "Explorer", "Ecosystem", "Build", "Security"];
export function prepareStoredLayout() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (
      !value ||
      value.schema !== 1 ||
      value.version !== 1 ||
      !value.root ||
      typeof value.root !== "object" ||
      !value.views ||
      typeof value.views !== "object"
    )
      throw new Error("Incompatible layout");
    const records = Object.values(value.views) as { type?: unknown }[];
    if (
      records.length !== 5 ||
      new Set(records.map((r) => r?.type)).size !== 5 ||
      records.some((r) => !names.includes(String(r?.type)))
    )
      throw new Error("Incompatible views");
  } catch {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Storage is optional; Trellis also catches storage access failures. */
    }
  }
}
