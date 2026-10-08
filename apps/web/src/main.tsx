import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "@/i18n";
import { applyNetworkLock } from "@/lib/network";
import { verifyNodeChainId } from "@rougechain/core/chain-id";

applyNetworkLock();
// Signatures commit to the network: check once per session, in the background, that the node
// reports the chain id of the selected network (signing is refused if it does not).
void verifyNodeChainId().catch(() => {});

createRoot(document.getElementById("root")!).render(<App />);
