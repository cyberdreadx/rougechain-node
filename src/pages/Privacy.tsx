import { Shield, Lock, Eye, Server, Trash2, Mail } from "lucide-react";

const Section = ({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) => (
  <div className="mb-10">
    <div className="flex items-center gap-3 mb-4">
      <div className="p-2 rounded-lg bg-accent/10 text-accent">
        <Icon className="w-5 h-5" />
      </div>
      <h2 className="text-xl font-semibold text-white">{title}</h2>
    </div>
    <div className="text-gray-300 space-y-3 leading-relaxed pl-12">
      {children}
    </div>
  </div>
);

const Privacy = () => {
  const lastUpdated = "March 9, 2026";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-white mb-3">Privacy Policy</h1>
          <p className="text-gray-400">Last updated: {lastUpdated}</p>
          <p className="text-gray-300 mt-4 leading-relaxed">
            RougeChain (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to
            protecting your privacy. This policy explains what data the RougeChain
            Wallet browser extension and the RougeChain website (
            <a
              href="https://rougechain.io"
              className="text-accent hover:underline"
            >
              rougechain.io
            </a>
            ) collect, how that data is used, and what rights you have.
          </p>
        </div>

        <Section icon={Eye} title="Information We Collect">
          <p>
            <strong className="text-white">Wallet data.</strong> When you create
            or import a wallet, cryptographic key pairs (ML-DSA-65 signing keys
            and ML-KEM-768 encryption keys) are generated locally on your device.
            Private keys are encrypted with your password using AES-GCM before
            being stored in your browser&apos;s local storage. We never have
            access to your private keys or password.
          </p>
          <p>
            <strong className="text-white">Messenger &amp; mail content.</strong>{" "}
            Messages and mail are end-to-end encrypted on your device before being
            transmitted. The RougeChain node relays encrypted ciphertext only. We
            cannot read, access, or decrypt any message or mail content.
          </p>
          <p>
            <strong className="text-white">Transaction data.</strong> Blockchain
            transactions (sends, token transfers) are signed locally and submitted
            to the RougeChain network. Transaction data is public on the
            blockchain by design.
          </p>
          <p>
            <strong className="text-white">Name registry.</strong> If you register
            an @rouge.quant address, the mapping between your chosen name and your
            public wallet ID is stored on-chain and is publicly visible.
          </p>
          <p>
            <strong className="text-white">Preferences &amp; settings.</strong>{" "}
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
          <ul className="list-disc pl-5 space-y-2">
            <li>
              Encrypted wallet credentials are stored locally so you can unlock
              your wallet between sessions.
            </li>
            <li>
              The extension connects to the RougeChain node (
              <code className="text-accent text-sm">testnet.rougechain.io</code>)
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
              <code className="text-accent text-sm">window.rougechain</code>) on
              web pages so dApps can request wallet connections and transaction
              signing, similar to MetaMask&apos;s{" "}
              <code className="text-accent text-sm">window.ethereum</code>.
            </li>
          </ul>
        </Section>

        <Section icon={Server} title="Data Storage & Security">
          <p>
            <strong className="text-white">Local-only storage.</strong> All
            sensitive data (private keys, wallet credentials, preferences, blocked
            lists) is stored exclusively in your browser&apos;s local storage or
            extension storage. Nothing is sent to our servers.
          </p>
          <p>
            <strong className="text-white">Encryption.</strong> Private keys are
            encrypted with AES-256-GCM using a key derived from your password via
            PBKDF2. Messages and mail use post-quantum ML-KEM-768 key
            encapsulation with AES-GCM symmetric encryption.
          </p>
          <p>
            <strong className="text-white">No remote code.</strong> All JavaScript
            and WebAssembly is bundled within the extension package. No code is
            fetched or executed from external sources.
          </p>
        </Section>

        <Section icon={Shield} title="Data Sharing & Third Parties">
          <p>
            We do <strong className="text-white">not</strong> sell, trade, or
            transfer your data to third parties.
          </p>
          <p>
            We do <strong className="text-white">not</strong> use your data for
            advertising, analytics, or profiling.
          </p>
          <p>
            We do <strong className="text-white">not</strong> use or transfer your
            data to determine creditworthiness or for lending purposes.
          </p>
          <p>
            The only external communication is between the extension and the
            RougeChain blockchain node to perform wallet operations (balance
            queries, transaction submission, message relay).
          </p>
        </Section>

        <Section icon={Mail} title="Permissions Explained">
          <div className="space-y-4">
            <div>
              <p className="text-white font-medium">storage</p>
              <p className="text-sm">
                Persist encrypted wallet data, contacts, conversation history, and
                preferences locally within the extension.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">alarms</p>
              <p className="text-sm">
                Schedule periodic background tasks to refresh balances and poll for
                new messages/mail.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">notifications</p>
              <p className="text-sm">
                Display local alerts for new encrypted messages, incoming mail, or
                completed transactions.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">
                Host permissions (testnet.rougechain.io)
              </p>
              <p className="text-sm">
                Communicate with the RougeChain node API for all blockchain
                operations.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">
                Content scripts (&lt;all_urls&gt;)
              </p>
              <p className="text-sm">
                Inject the <code className="text-accent">window.rougechain</code>{" "}
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

        <div className="mb-10 pl-0">
          <h2 className="text-xl font-semibold text-white mb-4">
            Children&apos;s Privacy
          </h2>
          <p className="text-gray-300 leading-relaxed">
            RougeChain is not directed at children under 13. We do not knowingly
            collect personal information from children.
          </p>
        </div>

        <div className="mb-10 pl-0">
          <h2 className="text-xl font-semibold text-white mb-4">
            Changes to This Policy
          </h2>
          <p className="text-gray-300 leading-relaxed">
            We may update this policy from time to time. Changes will be posted on
            this page with a revised &quot;Last updated&quot; date. Continued use
            of the extension after changes constitutes acceptance of the updated
            policy.
          </p>
        </div>

        <div className="border-t border-white/10 pt-8">
          <h2 className="text-xl font-semibold text-white mb-4">Contact</h2>
          <p className="text-gray-300 leading-relaxed">
            If you have questions about this privacy policy, you can reach us at{" "}
            <a
              href="https://rougechain.io"
              className="text-accent hover:underline"
            >
              rougechain.io
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
};

export default Privacy;
