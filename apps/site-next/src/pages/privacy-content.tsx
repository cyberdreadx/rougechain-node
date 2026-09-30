/* The RougeChain Privacy Policy — legal text copied verbatim from apps/web/src/pages/Privacy.tsx.
 * Kept as authored JSX (not in strings.ts): a translated policy would be a separately reviewed
 * legal document, not string-by-string i18n. Only markup/classes differ from apps/web. */
import type { ElementType, ReactNode } from "react";
import { Eye, Lock, Mail, Server, Shield, Trash2 } from "lucide-react";

export const PRIVACY_LAST_UPDATED = "March 9, 2026";

const Section = ({ icon: Icon, title, children }: { icon: ElementType; title: string; children: ReactNode }) => (
  <section className="rc-legal-section">
    <h2>
      <Icon size={18} aria-hidden="true" /> {title}
    </h2>
    <div className="rc-legal-body">{children}</div>
  </section>
);

export function PrivacyIntro() {
  return (
    <>
          <p>
            RougeChain (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to
            protecting your privacy. This policy explains what data the RougeChain
            Wallet browser extension and the RougeChain website (
            <a
              href="https://rougechain.io"
              className="text-link inline"
            >
              rougechain.io
            </a>
            ) collect, how that data is used, and what rights you have.
          </p>
    </>
  );
}

export function PrivacyBody() {
  return (
    <>
        <Section icon={Eye} title="Information We Collect">
          <p>
            <strong>Wallet data.</strong> When you create
            or import a wallet, cryptographic key pairs (ML-DSA-65 signing keys
            and ML-KEM-768 encryption keys) are generated locally on your device.
            Private keys are encrypted with your password using AES-GCM before
            being stored in your browser&apos;s local storage. We never have
            access to your private keys or password.
          </p>
          <p>
            <strong>Messenger &amp; mail content.</strong>{" "}
            Messages and mail are end-to-end encrypted on your device before being
            transmitted. The RougeChain node relays encrypted ciphertext only. We
            cannot read, access, or decrypt any message or mail content.
          </p>
          <p>
            <strong>Transaction data.</strong> Blockchain
            transactions (sends, token transfers) are signed locally and submitted
            to the RougeChain network. Transaction data is public on the
            blockchain by design.
          </p>
          <p>
            <strong>Name registry.</strong> If you register
            an @rouge.quant address, the mapping between your chosen name and your
            public wallet ID is stored on-chain and is publicly visible.
          </p>
          <p>
            <strong>Preferences &amp; settings.</strong>{" "}
            Display name, network selection, blocked wallet list, and UI
            preferences are stored locally in your browser and are never
            transmitted to us.
          </p>
        </Section>

        <Section icon={Lock} title="How We Use Your Information">
          <p>
            All data handling serves a single purpose: operating the RougeChain
            wallet, encrypted messenger, and encrypted mail. Specifically:
          </p>
          <ul>
            <li>
              Encrypted wallet credentials are stored locally so you can unlock
              your wallet between sessions.
            </li>
            <li>
              The extension connects to the RougeChain node (
              <code>api.rougechain.io</code>)
              to fetch balances, submit transactions, send/receive encrypted
              messages and mail, and resolve name registry entries.
            </li>
            <li>
              Alarms run periodically in the background to check for new messages,
              mail, and balance updates.
            </li>
            <li>
              Notifications alert you to new messages or mail — generated locally
              with no personal data included.
            </li>
            <li>
              The content script injects a provider API (
              <code>window.rougechain</code>) on
              web pages so dApps can request wallet connections and transaction
              signing, similar to MetaMask&apos;s{" "}
              <code>window.ethereum</code>.
            </li>
          </ul>
        </Section>

        <Section icon={Server} title="Data Storage & Security">
          <p>
            <strong>Local-only storage.</strong> All
            sensitive data (private keys, wallet credentials, preferences, blocked
            lists) is stored exclusively in your browser&apos;s local storage or
            extension storage. Nothing is sent to our servers.
          </p>
          <p>
            <strong>Encryption.</strong> Private keys are
            encrypted with AES-256-GCM using a key derived from your password via
            PBKDF2. Messages and mail use post-quantum ML-KEM-768 key
            encapsulation with AES-GCM symmetric encryption.
          </p>
          <p>
            <strong>No remote code.</strong> All JavaScript
            and WebAssembly is bundled within the extension package. No code is
            fetched or executed from external sources.
          </p>
        </Section>

        <Section icon={Shield} title="Data Sharing & Third Parties">
          <p>
            We do <strong>not</strong> sell, trade, or
            transfer your data to third parties.
          </p>
          <p>
            We do <strong>not</strong> use your data for
            advertising, analytics, or profiling.
          </p>
          <p>
            We do <strong>not</strong> use or transfer your
            data to determine creditworthiness or for lending purposes.
          </p>
          <p>
            The only external communication is between the extension and the
            RougeChain blockchain node to perform wallet operations (balance
            queries, transaction submission, message relay).
          </p>
        </Section>

        <Section icon={Mail} title="Permissions Explained">
          <div className="rc-perms">
            <div>
              <p className="rc-perm">storage</p>
              <p>
                Persist encrypted wallet data, contacts, conversation history, and
                preferences locally within the extension.
              </p>
            </div>
            <div>
              <p className="rc-perm">alarms</p>
              <p>
                Schedule periodic background tasks to refresh balances and poll for
                new messages/mail.
              </p>
            </div>
            <div>
              <p className="rc-perm">notifications</p>
              <p>
                Display local alerts for new encrypted messages, incoming mail, or
                completed transactions.
              </p>
            </div>
            <div>
              <p className="rc-perm">
                Host permissions (api.rougechain.io)
              </p>
              <p>
                Communicate with the RougeChain node API for all blockchain
                operations.
              </p>
            </div>
            <div>
              <p className="rc-perm">
                Content scripts (&lt;all_urls&gt;)
              </p>
              <p>
                Inject the <code>window.rougechain</code>{" "}
                provider so any dApp can request wallet interactions. The content
                script does not read or modify page content.
              </p>
            </div>
          </div>
        </Section>

        <Section icon={Trash2} title="Data Retention & Deletion">
          <p>
            All locally stored data can be deleted at any time by removing the
            extension or clearing your browser&apos;s extension storage. On-chain
            data (transactions, name registry entries) is immutable and cannot be
            deleted due to the nature of blockchain technology.
          </p>
        </Section>

        <section className="rc-legal-section">
          <h2>
            Children&apos;s Privacy
          </h2>
          <p>
            RougeChain is not directed at children under 13. We do not knowingly
            collect personal information from children.
          </p>
        </section>

        <section className="rc-legal-section">
          <h2>
            Changes to This Policy
          </h2>
          <p>
            We may update this policy from time to time. Changes will be posted on
            this page with a revised &quot;Last updated&quot; date. Continued use
            of the extension after changes constitutes acceptance of the updated
            policy.
          </p>
        </section>

        <section className="rc-legal-section rc-legal-contact">
          <h2>Contact</h2>
          <p>
            If you have questions about this privacy policy, you can reach us at{" "}
            <a
              href="https://rougechain.io"
              className="text-link inline"
            >
              rougechain.io
            </a>
            .
          </p>
        </section>
    </>
  );
}
