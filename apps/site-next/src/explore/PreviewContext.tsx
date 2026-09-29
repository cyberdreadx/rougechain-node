import { createContext, useContext } from "react";
import type { WorkspaceView } from "./model";
export interface BlockPreview {
  height: number;
  hash: string;
  transactions: number;
  timestamp: number;
  provenance: string;
}
export const PreviewContext = createContext<{
  open: (name: WorkspaceView) => void;
  openBlock: (block: BlockPreview) => void;
}>({
  open: (name) => {
    window.location.href = `/workspace?open=${name.toLowerCase()}`;
  },
  openBlock: () => {
    window.location.href = "/workspace?open=explorer";
  },
});
export const usePreview = () => useContext(PreviewContext);
