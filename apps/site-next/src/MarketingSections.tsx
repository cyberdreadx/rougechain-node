import { appHref, appById, WHITEPAPER_URL } from "./ecosystem/apps";
import {
  ArrowUpRight,
  ArrowRight,
  Terminal,
  ShieldCheck,
  Layers,
} from "lucide-react";
import { Section, TextLink, CodeBlock } from "@rougechain/ui";
import { DOCS, GITHUB } from "./Shell";
import { team } from "./team";
export default function MarketingSections() {
  return (
    <>
      <Section id="build" eyebrow="03 / Built for builders">
        <div className="build-layout">
          <div>
            <h2>
              Your next idea.
              <br />A new foundation.
            </h2>
            <p>
              From the first query to a programmable application.
              <br />
              Explore the tools behind RougeChain.
            </p>
            <div className="terminal">
              <div className="terminal-heading">
                <Terminal size={14} />
                <span>START WITH THE SDK</span>
              </div>
              <CodeBlock>
                <span className="muted">$ </span>npm install @rougechain/sdk
              </CodeBlock>
              <div className="terminal-divider" />
              <CodeBlock>
                {
                  '// Public network data. Read only.\nconst response = await fetch(\n  "https://api.rougechain.io/api/stats"\n);\nconst network = await response.json();'
                }
              </CodeBlock>
            </div>
          </div>
          <div className="resource-list">
            {[
              ["01", "SDK & API", "Connect your application to the network."],
              [
                "02",
                "WASM contracts",
                "Build programmable onchain experiences.",
              ],
              ["03", "Run a node", "Understand the network infrastructure."],
              [
                "04",
                "MCP for agents",
                "Explore agent and network integration.",
              ],
            ].map(([n, title, copy]) => (
              <a href={DOCS} key={n}>
                <span className="mono muted">{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <ArrowUpRight size={20} />
              </a>
            ))}
            <div className="actions resource-footer">
              <TextLink href={GITHUB}>View source</TextLink>
              <TextLink href={DOCS}>All documentation</TextLink>
            </div>
          </div>
        </div>
      </Section>
      <Section id="ecosystem" eyebrow="04 / Beyond the chain">
        <div className="section-heading">
          <h2>
            One foundation.
            <br />
            Many possibilities.
          </h2>
          <TextLink href="#explore">Explore the ecosystem</TextLink>
        </div>
        <div className="ecosystem-feature">
          <div className="qwalla-image">
            <div className="qwalla-phone">
              <div className="qwalla-phone-speaker" aria-hidden="true" />
              <img
                src="/qwalla-app.jpg"
                alt="Full Qwalla wallet screen shown in a phone mockup"
                width="1206"
                height="2459"
                loading="lazy"
              />
              <div className="qwalla-phone-home" aria-hidden="true" />
            </div>
          </div>
          <div className="ecosystem-copy">
            <span className="mono muted">IN THE ECOSYSTEM / QWALLA</span>
            <h3>
              Make the network
              <br />
              part of your everyday.
            </h3>
            <p>
              Qwalla connects the RougeChain ecosystem to a broader application
              experience. Discover how the pieces fit together.
            </p>
            <TextLink href={appHref(appById("qwalla")!)}>
              Discover Qwalla
            </TextLink>
          </div>
        </div>
        <div className="ecosystem-row">
          <a href={appHref(appById("wallet")!)}>
            <Layers size={22} />
            <div>
              <h3>RougeChain Wallet</h3>
              <p>Your entry to the ecosystem.</p>
            </div>
            <ArrowUpRight size={20} />
          </a>
          <a href="/explorer">
            <Terminal size={22} />
            <div>
              <h3>See every layer</h3>
              <p>Explore blocks and network activity.</p>
            </div>
            <ArrowUpRight size={20} />
          </a>
          <a href="/swap">
            <ArrowRight size={22} />
            <div>
              <h3>A new exchange</h3>
              <p>Preview the Swap design concept.</p>
            </div>
            <ArrowUpRight size={20} />
          </a>
        </div>
      </Section>
      <Section id="security" eyebrow="05 / Security & transparency">
        <div className="security-layout">
          <div>
            <ShieldCheck size={28} className="security-icon" />
            <h2>
              Cryptography built
              <br />
              for the next era.
              <br />
              <span className="muted">Built in public.</span>
            </h2>
            <p>
              A deliberate cryptographic stack. Open technical materials.
              <br />
              Explore the primitives behind the protocol.
            </p>
            <div className="actions">
              <TextLink href={GITHUB}>Inspect the source</TextLink>
              <TextLink href={WHITEPAPER_URL}>Whitepaper</TextLink>
            </div>
          </div>
          <div className="crypto-list">
            {[
              ["ML-DSA-65", "Digital signatures", "FIPS 204"],
              ["ML-KEM-768", "Key encapsulation", "FIPS 203"],
              ["SHA-256", "Cryptographic hashing", "FIPS 180-4"],
            ].map(([name, desc, fips]) => (
              <div key={name}>
                <div>
                  <h3>{name}</h3>
                  <p>{desc}</p>
                </div>
                <span className="mono muted">{fips}</span>
              </div>
            ))}
            <p className="small-note">
              Standards identify the cryptographic primitives. They do not imply
              an external audit of RougeChain.
            </p>
          </div>
        </div>
      </Section>
      <Section id="xrge" eyebrow="06 / The native asset">
        <div className="token-section">
          <div className="token-identity">
            <img src="/xrge-logo.webp" alt="XRGE mark" loading="lazy" />
            <span>XRGE</span>
          </div>
          <div>
            <h2>
              Part of the network.
              <br />
              At the heart of its utility.
            </h2>
            <p>
              The native asset of RougeChain. Explore its role in network fees,
              validator staking, and the wider ecosystem.
            </p>
            <div className="actions">
              <TextLink href={DOCS}>Understand XRGE</TextLink>
              <a className="text-link" href="/swap">
                View Swap design demo <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
        </div>
      </Section>
      <Section id="community" eyebrow="07 / Regenerate">
        <div className="community-layout">
          <h2>
            Technology moves forward.
            <br />
            <span className="muted">People give it direction.</span>
          </h2>
          <div>
            <p>
              Regenerate is part of the RougeChain story. Join the conversation
              around a network, its community, and what comes next.
            </p>
            <div className="actions">
              <TextLink href="https://discord.gg/Fn6CCrx8jP">
                Join Discord
              </TextLink>
              <TextLink href="https://x.com/rougecoin">
                Follow RougeChain
              </TextLink>
            </div>
          </div>
        </div>
      </Section>
      <Section id="team" eyebrow="08 / People behind the protocol">
        <div className="section-heading">
          <h2>Building the next chapter.</h2>
          <p>Engineering, creativity, and community.</p>
        </div>
        <div className="team-grid">
          {team.map((p) => (
            <article key={p.name}>
              <div className="portrait">
                <img src={p.image} alt={p.name} loading="lazy" />
              </div>
              <h3>{p.name}</h3>
              <p className="team-role">{p.role}</p>
              <details>
                <summary>About {p.name.split(" ")[0]}</summary>
                <p>{p.bio}</p>
              </details>
              {p.linkedin && <TextLink href={p.linkedin}>LinkedIn</TextLink>}
            </article>
          ))}
        </div>
      </Section>
      <Section className="final-cta" eyebrow="The next era starts here">
        <h2>
          Build on a chain designed
          <br />
          for the post-quantum era.
        </h2>
        <div className="actions">
          <a className="button" href="/explorer">
            Explore the network <ArrowRight size={16} />
          </a>
          <a className="button outline" href={DOCS}>
            Read the docs <ArrowUpRight size={16} />
          </a>
        </div>
      </Section>
    </>
  );
}
