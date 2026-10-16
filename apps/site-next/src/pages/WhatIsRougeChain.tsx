/* "What Is RougeChain and How Does XRGE Work" — explainer article at /learn/what-is-rougechain.
 * English only, authored JSX (like the privacy policy body); page frame from the legal pages. */
import type { ReactNode } from "react";
import { useRouteSeo } from "./common";
import "./pages.css";

const DOCS = "https://docs.rougechain.io";

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-link inline">
    {children}
  </a>
);

const H2 = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;

export default function WhatIsRougeChain() {
  useRouteSeo({
    title: "What Is RougeChain and How Does XRGE Work — RougeChain",
    description:
      "RougeChain is a Layer 1 blockchain with post-quantum ML-DSA-65 signatures. What XRGE does, how native XRGE differs from XRGE on Base, and what is live today.",
  });
  return (
    <main id="main" className="app-main rc-page rc-legal">
      <article className="container rc-narrow rc-article" lang="en">
        <header className="rc-legal-head">
          <div className="eyebrow">Learn</div>
          <h1>What Is RougeChain and How Does XRGE Work</h1>
          <p className="mono muted">By RougeChain</p>
        </header>
        <p>
          RougeChain is a Layer 1 blockchain that uses post-quantum digital signatures for its native
          transactions. XRGE is the network&apos;s native asset, used for transaction fees, validator
          staking, and trading pairs in its built-in exchange. The{" "}
          <Ext href={`${DOCS}/`}>RougeChain documentation</Ext> introduces the network and its
          applications.
        </p>
        <p>
          RougeChain also has an XRGE token on Base. Understanding the difference between the native
          network and the Base token helps explain both how XRGE works and where its security
          protections apply.
        </p>

        <H2>What post-quantum security means</H2>
        <p>
          Digital signatures let a network check who authorized a transaction and whether the signed
          information has changed. Post-quantum cryptography uses mathematical approaches designed to
          resist attacks from both conventional computers and future powerful quantum computers.
        </p>
        <p>
          RougeChain uses ML-DSA-65 for native transaction and block signatures. ML-DSA is the
          digital-signature algorithm standardized by the US National Institute of Standards and
          Technology in <Ext href="https://csrc.nist.gov/pubs/fips/204/final">FIPS 204</Ext>. The{" "}
          <Ext href={`${DOCS}/advanced/pqc-cryptography.html`}>cryptography documentation</Ext>{" "}
          explains its role in RougeChain.
        </p>
        <p>
          Using a standardized algorithm is one part of a security design. It does not certify the
          entire blockchain, its applications, or its bridges. Implementation quality and the way a
          network operates still matter.
        </p>

        <H2>What XRGE does on RougeChain</H2>
        <p>Native XRGE has three principal roles:</p>
        <ul>
          <li>
            <strong>Transaction fees:</strong> users pay fees when submitting
            transactions.
          </li>
          <li>
            <strong>Validator staking:</strong> validators commit XRGE as stake
            under the network&apos;s rules.
          </li>
          <li>
            <strong>Exchange activity:</strong> XRGE serves as a trading-pair
            asset in the native automated market maker, which uses liquidity pools for swaps.
          </li>
        </ul>
        <p>
          These functions connect XRGE to network activity. A user executing an on-chain action and a
          developer deploying an application interact with the same underlying network asset. The{" "}
          <Ext href={`${DOCS}/`}>documentation overview</Ext> explains these uses.
        </p>

        <H2>How native XRGE differs from XRGE on Base</H2>
        <p>
          On RougeChain, XRGE is native to the network. On Base, XRGE is represented by an ERC-20
          token. The <Ext href={`${DOCS}/bridge/xrge-bridge.html`}>XRGE bridge</Ext> connects these
          two environments.
        </p>
        <p>
          Holding XRGE on Base does not automatically move a balance onto RougeChain. Moving between
          the networks requires the bridge process and introduces the bridge&apos;s own security
          assumptions.
        </p>
        <p>
          The production XRGE bridge uses classical authorization on its Base side. RougeChain&apos;s
          post-quantum transaction signatures therefore do not make every step of a Base-to-RougeChain
          transfer post-quantum. The <Ext href={`${DOCS}/security.html`}>security overview</Ext>{" "}
          explains this boundary.
        </p>

        <H2>What developers can build</H2>
        <p>
          RougeChain supports smart contracts compiled to WebAssembly, commonly called WASM. Developers
          can write contracts in Rust or another compatible language and deploy the compiled program to
          the chain.
        </p>
        <p>
          The <Ext href={`${DOCS}/advanced/smart-contracts.html`}>smart-contract documentation</Ext>{" "}
          describes signed deployments and calls, contract storage, transfers, and interaction with
          tokens and NFTs. These features provide building blocks for applications such as games,
          collectible systems, and marketplaces.
        </p>
        <p>
          The ecosystem also includes encrypted messaging and mail. These services use ML-KEM-768 for
          key encapsulation, a different cryptographic task from signing blockchain transactions.
          Messages are hosted by nodes rather than recorded as consensus-replicated blockchain data.
          The <Ext href={`${DOCS}/advanced/messaging.html`}>messaging documentation</Ext> explains that
          architecture and its privacy limits.
        </p>

        <H2>What is live and what is still developing</H2>
        <p>
          RougeChain&apos;s <Ext href={`${DOCS}/status.html`}>status review dated October 6, 2026</Ext>{" "}
          describes a live mainnet with concentrated validator stake and a single block producer. It
          lists the V3 post-quantum XRGE bridge as built but not deployed, with an external audit
          pending.
        </p>
        <p>
          Those distinctions matter when evaluating the project. A feature listed on a roadmap should
          be assessed separately from an active network feature. Consult the status page for
          deployment changes and the security page for the assumptions behind each component.
        </p>

        <H2>Where to start</H2>
        <p>
          Start with the <Ext href={`${DOCS}/`}>RougeChain documentation</Ext> to learn about wallets,
          transactions, and development. Developers can inspect the{" "}
          <Ext href="https://github.com/cyberdreadx/rougechain-node">public node repository</Ext>{" "}
          alongside the smart-contract examples.
        </p>
        <p>
          For an initial evaluation, choose one concrete task: understand a signed transaction, review
          a contract example, or examine how the bridge distinguishes the two networks. That gives you
          a practical basis for deciding which part of RougeChain you want to explore next.
        </p>
      </article>
    </main>
  );
}
