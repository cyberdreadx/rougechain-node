import { WHITEPAPER_URL } from "./ecosystem/apps";
import { ArrowUpRight, ArrowRight, Terminal, ShieldCheck } from "lucide-react";
import { Section, TextLink, CodeBlock } from "@rougechain/ui";
import { DOCS, GITHUB } from "./Shell";
import { team } from "./team";
import EcosystemCarousel from "./EcosystemCarousel";
import Explore from "./explore/Explore";
export default function MarketingSections() {
  return (
    <>
      <Section id="build" eyebrow="02 / Built for builders">
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
      <Section id="security" eyebrow="03 / Security & transparency">
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
              ["ML-DSA-65", "Post-quantum digital signatures", "FIPS 204"],
              ["ML-KEM-768", "Post-quantum key encapsulation", "FIPS 203"],
              [
                "AES-256-GCM",
                "Authenticated data encryption",
                "FIPS 197 / SP 800-38D",
              ],
              [
                "SHA-256 + BLAKE3",
                "Hashing & proof commitments",
                "FIPS 180-4 / BLAKE3",
              ],
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
              ML-KEM-768 establishes or wraps keys; AES-256-GCM encrypts data.
              SHA-256 and BLAKE3 are hashing primitives, not encryption.
              Standards identify the primitives; they do not imply an external
              audit of RougeChain.
            </p>
          </div>
        </div>
      </Section>
      <Section id="ecosystem" eyebrow="04 / Beyond the chain">
        <div className="section-heading ecosystem-heading">
          <div>
            <h2>
              One foundation.
              <br />
              Many possibilities.
            </h2>
            <p>
              Hold. Trade. Move. Communicate. Validate. Build.
              <br />
              Explore what becomes possible on RougeChain.
            </p>
          </div>
        </div>
        <EcosystemCarousel />
      </Section>
      <Section id="xrge" eyebrow="05 / The native asset">
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
      <Section id="team" eyebrow="06 / People behind the protocol">
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
      <Section id="regenerate" eyebrow="07 / Regenerate">
        <div className="community-layout">
          <h2>
            Technology should improve
            <br />
            <span className="muted">the territory it touches.</span>
          </h2>
          <div>
            <p>
              RougeChain Regenerate connects blockchain infrastructure with
              real-world community development—funding transparent, measurable
              local initiatives across ecology, infrastructure, technology, art,
              and community. Starting in Tulum, project funding, milestones,
              evidence, and impact can be recorded through RougeChain so
              progress is visible from capital to outcome.
            </p>
            <div className="actions">
              <TextLink href="https://rougechain.io/regenerate">
                Explore Regenerate
              </TextLink>
              <TextLink href="https://rougechain.io/regenerate#propose">
                Propose a Project
              </TextLink>
            </div>
          </div>
        </div>
      </Section>
      <Explore />
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
