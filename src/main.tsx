import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "@/i18n";
import { applyNetworkLock } from "@/lib/network";

applyNetworkLock();

createRoot(document.getElementById("root")!).render(<App />);
