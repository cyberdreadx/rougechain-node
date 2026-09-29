import { useRef, useState } from "react";
import { Section, Button } from "@rougechain/ui";
import { WalletControl, ConnectWalletDialog } from "./WalletControl";
import { DEMO_SHORT_ADDRESS } from "./DemoWalletProvider";
export function WalletSpecimens() {
  const [chooser, setChooser] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Section
      id="wallet-controls"
      eyebrow="00 / Shared identity"
      title="One account across the ecosystem."
    >
      <p>
        Account identity is global product state. Transaction capability belongs
        to the future wallet-provider implementation.
      </p>
      <div className="specimen-grid">
        <article className="surface">
          <h3>Disconnected / Connected</h3>
          <div className="wallet-state-specimens">
            <span className="button outline small">Connect Wallet</span>
            <span className="button outline small">
              Demo · {DEMO_SHORT_ADDRESS}
            </span>
          </div>
          <p className="pane-note">
            Static state specimens. Color never carries connection state alone.
          </p>
        </article>
        <article className="surface">
          <h3>Interactive wallet control</h3>
          <WalletControl />
          <p className="pane-note">
            Connect to preview the account menu, copy address, Open Wallet,
            Explorer notice and Disconnect. Every shell reflects the same demo
            identity.
          </p>
          <button
            ref={trigger}
            className="button ghost small"
            onClick={() => setChooser(true)}
          >
            Open provider chooser specimen
          </button>
        </article>
      </div>
      <ConnectWalletDialog
        open={chooser}
        onClose={() => {
          setChooser(false);
          window.requestAnimationFrame(() => trigger.current?.focus());
        }}
      />
      <Button
        variant="ghost small"
        onClick={() => {
          window.location.href = "/workspace?open=wallet";
        }}
      >
        See identity in the workspace ↗
      </Button>
    </Section>
  );
}
