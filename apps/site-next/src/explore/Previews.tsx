import {
  useDemoWallet,
  DEMO_SHORT_ADDRESS,
} from "../wallet/DemoWalletProvider";
import { useState } from "react";
import { Button, Status, CodeBlock } from "@rougechain/ui";
import { useNetwork } from "../Network";
import { DOCS_URL } from "../ecosystem/apps";
import { quote } from "../Swap";
// POC ONLY: these previews simulate UI state, not wallet, messaging or transaction services.
export function WalletPreview() {
  const wallet = useDemoWallet();
  return (
    <div className="explore-content">
      <Status state="demo">Wallet preview</Status>
      <h3>Your assets</h3>
      {wallet.connected ? (
        <p>
          <strong>{DEMO_SHORT_ADDRESS}</strong>
          <br />
          <span className="muted">Demo connected · synthetic identity</span>
        </p>
      ) : (
        <p>No wallet connected.</p>
      )}
      {["XRGE", "qETH", "qUSDC"].map((t) => (
        <div className="preview-row" key={t}>
          <strong>{t}</strong>
          <span>—</span>
        </div>
      ))}
      <div className="preview-actions">
        <Button disabled>Send</Button>
        <Button disabled variant="outline">
          Receive
        </Button>
      </div>
      <p className="pane-note">
        No keys, account access or signing in this demo.
      </p>
    </div>
  );
}
export function SwapPreview() {
  const wallet = useDemoWallet();
  const [amount, setAmount] = useState("100");
  return (
    <div className="explore-content">
      <Status state="demo">Synthetic quote</Status>
      <h3>Swap assets</h3>
      <p className="pane-note">
        {wallet.connected
          ? `Demo account: ${DEMO_SHORT_ADDRESS}`
          : "Connect Wallet in the header to preview a shared identity."}
      </p>
      <label className="preview-label">
        Pay · XRGE
        <input
          type="number"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <div className="preview-row">
        <span>Receive · qETH</span>
        <strong>{quote(amount, "XRGE", "qETH")?.toFixed(6) ?? "—"}</strong>
      </div>
      <Button disabled>Swap unavailable</Button>
      <p className="pane-note">
        Illustrative rate. No quote or transaction service.
      </p>
      <a className="text-link" href="/swap">
        Open full Swap ↗
      </a>
    </div>
  );
}
export function BridgePreview() {
  const wallet = useDemoWallet();
  const [reverse, setReverse] = useState(false);
  return (
    <div className="explore-content">
      <Status state="demo">Bridge preview</Status>
      <p className="pane-note">
        {wallet.connected
          ? `Demo account: ${DEMO_SHORT_ADDRESS}`
          : "No wallet connected."}
      </p>
      <h3>{reverse ? "RougeChain → Base" : "Base → RougeChain"}</h3>
      <Button variant="ghost small" onClick={() => setReverse(!reverse)}>
        Reverse direction
      </Button>
      <p>Assets · XRGE / qETH / qUSDC</p>
      <div className="preview-row">
        Bridge activity <span>—</span>
      </div>
      <Button disabled>Bridge unavailable</Button>
      <p className="pane-note">No approvals, deposits or withdrawals.</p>
    </div>
  );
}
export function MessengerPreview() {
  const wallet = useDemoWallet();
  const [tab, setTab] = useState("Conversations");
  return (
    <div className="explore-content">
      <Status state="demo">Messenger preview</Status>
      <div className="preview-actions">
        {["Conversations", "Contacts"].map((t) => (
          <Button
            key={t}
            variant="ghost small"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <h3>{tab === "Contacts" ? "No contacts yet" : "Your conversations"}</h3>
      <p>
        {wallet.connected
          ? "Demo identity available. Messaging identity has not been initialized."
          : "No account connected. Messages would appear here."}
      </p>
      <Button disabled>Compose unavailable</Button>
      <p className="pane-note">No messages sent or encryption performed.</p>
    </div>
  );
}
export function MailPreview() {
  const [tab, setTab] = useState("Inbox");
  return (
    <div className="explore-content">
      <Status state="demo">Mail preview</Status>
      <div className="preview-actions">
        {["Inbox", "Sent"].map((t) => (
          <Button
            key={t}
            variant="ghost small"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <h3>{tab} is empty</h3>
      <p>No mail account connected.</p>
      <Button disabled>Compose unavailable</Button>
      <p className="pane-note">No mail is fetched or sent.</p>
    </div>
  );
}
export function ValidatorsPreview() {
  const wallet = useDemoWallet();
  const n = useNetwork();
  return (
    <div className="explore-content">
      <Status state={n.state}>
        {n.state === "live" ? "Live API" : n.state}
      </Status>
      <h3>Network validators</h3>
      {wallet.connected && (
        <p className="pane-note">
          Wallet preview connected · no staking account loaded
        </p>
      )}
      <div className="network-height">{n.data?.validators ?? "—"}</div>
      <p>Reported by the public API · mainnet</p>
      <a className="text-link" href={DOCS_URL}>
        Run a node documentation ↗
      </a>
      <p>
        <a href="/architecture">Staking architecture proposal ↗</a>
      </p>
      <Button disabled>Stake unavailable</Button>
    </div>
  );
}
export function DeveloperExtras() {
  return (
    <>
      <CodeBlock>npm install @rougechain/sdk</CodeBlock>
      <p className="pane-note">SDK · WASM · MCP / Agents · Run a Node</p>
    </>
  );
}
