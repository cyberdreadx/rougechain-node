import { Section, Status } from "@rougechain/ui";
import { apps, globalApps, globalAppGroups, appHref } from "./ecosystem/apps";
export default function Architecture() {
  return (
    <main id="main">
      <div className="container page-intro">
        <div className="eyebrow">Ecosystem / Architecture proposal</div>
        <h1>
          One identity.
          <br />
          <span className="muted">Independent applications.</span>
        </h1>
        <p>
          Shared foundations connect the ecosystem. Each application owns its
          routes, deployment and release cycle.
        </p>
        <Status state="demo">POC topology · No host migration</Status>
        <p>
          <a className="text-link" href="#wallet-architecture">
            See the wallet-provider architecture ↓
          </a>
        </p>
      </div>
      <Section
        eyebrow="01 / Proposed destinations"
        title="A network of applications."
      >
        <div className="topology-root">
          rougechain.io <span>Marketing · discovery · global Apps menu</span>
        </div>
        <div className="topology-groups">
          {globalAppGroups.map((group) => (
            <section key={group}>
              <h3>{group}</h3>
              {globalApps
                .filter((a) => a.group === group)
                .map((a) => (
                  <article key={a.id}>
                    {a.status === "future" ? (
                      <span>{a.name} · Coming soon</span>
                    ) : (
                      <a href={appHref(a)}>{a.name} ↗</a>
                    )}
                    <code>{a.proposedHost}</code>
                    <small>Proposed destination · {a.status}</small>
                  </article>
                ))}
            </section>
          ))}
        </div>
      </Section>
      <Section
        eyebrow="02 / Beyond applications"
        title="Different questions. Clear destinations."
      >
        <div className="specimen-grid">
          {(["developer-resource", "community", "utility"] as const).map(
            (kind) => (
              <article className="surface" key={kind}>
                <h3>
                  {kind === "developer-resource"
                    ? "Build"
                    : kind === "community"
                      ? "Community"
                      : "Utilities"}
                </h3>
                <p className="pane-note">
                  {kind === "developer-resource"
                    ? "What can I build?"
                    : kind === "community"
                      ? "Where can I participate?"
                      : "What can I inspect?"}
                </p>
                {apps
                  .filter((a) => a.kind === kind)
                  .map((a) => (
                    <p key={a.id}>
                      {a.status === "future" ? (
                        <span>{a.name} · Coming soon</span>
                      ) : (
                        <a href={appHref(a)}>{a.name} ↗</a>
                      )}
                    </p>
                  ))}
              </article>
            ),
          )}
        </div>
        <p>
          The marketing navigation introduces the project. Apps groups
          applications under Hold, Trade, Play, Talk and Explore. Local
          navigation belongs to the current dApp. The workspace launcher opens
          applications plus tools such as Build, Security and Network.
        </p>
      </Section>
      <Section
        id="wallet-architecture"
        eyebrow="03 / Shared wallet architecture"
        title="One identity. A reviewed provider boundary."
      >
        <p>
          Each dApp consumes a common wallet-provider contract rather than
          owning private keys itself.
        </p>
        <figure
          className="wallet-flow"
          aria-label="Proposed wallet-provider architecture"
        >
          <div className="wallet-flow-providers">
            <div>
              RougeChain Browser Wallet
              <small>Extension provider candidate</small>
            </div>
            <div>
              Qwalla<small>Mobile / dApp browser candidate</small>
            </div>
          </div>
          <div className="wallet-flow-connector" aria-hidden="true">
            ↓
          </div>
          <div className="wallet-flow-contract">
            <code>@rougechain/wallet-provider</code>
            <small>Proposed contract · account · network · permissions</small>
          </div>
          <div className="wallet-flow-connector" aria-hidden="true">
            ↓
          </div>
          <div className="wallet-flow-apps">
            {globalApps
              .filter((a) => a.workspaceView)
              .map((a) => (
                <span key={a.id}>{a.name}</span>
              ))}
          </div>
          <figcaption>
            Conceptual production architecture. Final provider and security
            design belongs to the lead developer.
          </figcaption>
        </figure>
        <div className="specimen-grid">
          <article className="surface">
            <h3>What the POC demonstrates</h3>
            <p>
              DemoWalletProvider shares one synthetic identity across routes and
              workspace previews. Session storage retains only a demo flag,
              synthetic address and selected source.
            </p>
            <p>
              No provider, permissions, keys or signing are involved. This
              single-origin demo does not prove cross-origin wallet
              connectivity.
            </p>
          </article>
          <article className="surface">
            <h3>What production must evaluate</h3>
            <p>
              RougeChain browser extension, Qwalla and an authoritative web
              wallet origin are provider candidates.
            </p>
            <p>
              Connection, account/network state and transaction permissions need
              a reviewed contract. No signing or transaction methods are
              implemented here.
            </p>
          </article>
        </div>
        <div className="architecture-note">
          <strong>Wallet identity/provider ≠ raw private-key storage</strong>
          <p>
            localStorage does not cross origins/subdomains. The future provider
            strategy must not attempt to share raw vault storage between dApps.
            Preserve access to existing vaults until a deliberate migration is
            approved.
          </p>
        </div>
      </Section>
      <Section
        eyebrow="04 / Boundaries"
        title="Share the language. Own the product."
      >
        <div className="specimen-grid">
          <article className="surface">
            <h3>Implemented in this POC</h3>
            <p>@rougechain/brand — tokens and identity</p>
            <p>@rougechain/ui — primitives and RougeAppShell</p>
            <p>@rougechain/chain-readonly — allowlisted GET data</p>
            <p>
              Showcase owns the ecosystem registry, routes and workspace
              previews.
            </p>
          </article>
          <article className="surface">
            <h3>Proposed production packages</h3>
            <p>app-shell · chain-client · network-config · i18n</p>
            <p>
              @rougechain/wallet-provider requires a separately approved trust
              and origin architecture.
            </p>
            <p>
              Independent deployments consume versioned packages. No shared
              runtime server is required for this POC.
            </p>
          </article>
        </div>
      </Section>
      <Section eyebrow="05 / Transition" title="Move deliberately.">
        <ol className="migration-steps">
          <li>Adopt shared brand and UI tokens in one existing surface.</li>
          <li>
            Extract the app shell and navigation registry with ownership agreed.
          </li>
          <li>Pilot Explorer on its own host with verified data contracts.</li>
          <li>
            Move Swap only after wallet, signing and origin boundaries are
            approved.
          </li>
          <li>
            Redirect old paths only after each destination is deployed and
            stable.
          </li>
        </ol>
        <p>
          The global switcher crosses applications and hosts. Local navigation
          stays inside the current application. POC routes demonstrate these
          boundaries on one origin.
        </p>
        <div className="architecture-note">
          <strong>Wallet origin boundary</strong>
          <p>
            localStorage is origin-scoped. Wallet material on rougechain.io will
            not automatically transfer to wallet.rougechain.io. A
            wallet-provider design, migration policy and security review are
            required before any split. This POC never reads or stores wallet
            material.
          </p>
        </div>
      </Section>
    </main>
  );
}
