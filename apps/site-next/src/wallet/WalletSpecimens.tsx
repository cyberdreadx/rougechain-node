import { Link } from "react-router-dom";
import { Section } from "@rougechain/ui";
import { WalletControl } from "./WalletControl";

/** Design-system specimen of the wallet control (the live control, plus static state specimens). */
export function WalletSpecimens() {
  return (
    <Section id="wallet-controls" eyebrow="00 / Shared identity" title="One account across the ecosystem.">
      <p>
        The header wallet control reads the same browser wallet as the Wallet page: create, import, unlock, lock and connect the
        RougeChain extension from any route.
      </p>
      <div className="specimen-grid">
        <article className="surface">
          <h3>Disconnected / Locked / Connected</h3>
          <div className="wallet-state-specimens">
            <span className="button outline small">Connect Wallet</span>
            <span className="button outline small">Locked</span>
            <span className="button outline small">rouge1q8f3x7k2…k9m2</span>
          </div>
          <p className="pane-note">Static state specimens. Color never carries connection state alone.</p>
        </article>
        <article className="surface">
          <h3>Live wallet control</h3>
          <WalletControl />
          <p className="pane-note">
            This is the real control: it opens the connect, unlock or account menu for the wallet in this browser.
          </p>
          <Link className="button ghost small" to="/wallet">
            Open the Wallet ↗
          </Link>
        </article>
      </div>
    </Section>
  );
}
