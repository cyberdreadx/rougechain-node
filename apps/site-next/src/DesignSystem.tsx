import { WalletSpecimens } from "./wallet/WalletSpecimens";
import { AppSwitcher } from "./ecosystem/AppSwitcher";
import { AppHeader } from "./Shell";
import { Launcher } from "./explore/Launcher";
import { WalletPreview } from "./explore/Previews";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  Button,
  Section,
  Status,
  Metric,
  Surface,
  Dialog,
  CodeBlock,
} from "@rougechain/ui";
import { brand } from "@rougechain/brand";
export default function DesignSystem() {
  const [open, setOpen] = useState(false);
  return (
    <main id="main">
      <div className="container page-intro">
        <div className="eyebrow">Reference / 01</div>
        <h1>
          A shared language.
          <br />
          <span className="muted">An unmistakable identity.</span>
        </h1>
        <p>
          The RougeChain interface system. Quiet surfaces, precise data,
          <br className="desktop" /> and one deliberate brand gesture at a time.
        </p>
        <span className="mono muted">DESIGN SYSTEM · VERSION 2.1</span>
        <p>
          <a className="text-link" href="#wallet-controls">
            Review wallet controls ↓
          </a>
        </p>
      </div>
      <Section
        eyebrow="00 / Ecosystem navigation"
        title="A shared way to move."
      >
        <p>
          Global Apps crosses products; local navigation stays within the
          current app.
        </p>
        <AppSwitcher />
        <div className="shell-specimen">
          <AppHeader product="Explorer" />
        </div>
        <div className="specimen-grid">
          <article className="surface">
            <h3>Grouped launcher</h3>
            <Launcher
              onOpen={(name) => {
                window.location.href = `/workspace?open=${name.toLowerCase()}`;
              }}
              state={() => "Not opened"}
            />
          </article>
          <article className="surface">
            <h3>Preview panel</h3>
            <WalletPreview />
          </article>
        </div>
        <a className="text-link" href="/architecture">
          Explore the architecture proposal ↗
        </a>
      </Section>
      <WalletSpecimens />
      <Section eyebrow="01 / Foundation" title="Color with a purpose.">
        <div className="swatches">
          {Object.entries(brand)
            .filter(([k]) => !["font", "mono"].includes(k))
            .map(([name, color]) => (
              <div key={name}>
                <div className="swatch" style={{ background: color }} />
                <div>{name}</div>
                <span className="mono muted">{color}</span>
              </div>
            ))}
        </div>
        <div className="spectrum" />
        <p className="small-note">
          Red → magenta → violet is the brand. Teal is reserved for verified
          operational state.
        </p>
      </Section>
      <Section eyebrow="02 / Typography" title="Space to say more.">
        <div className="two-col">
          <div>
            <div className="display-sample">Aa</div>
            <h3>Space Grotesk</h3>
            <p>Display, headings, interfaces, and body copy.</p>
          </div>
          <div className="type-scale">
            <div className="heading-one-sample">Heading one</div>
            <h2>Heading two</h2>
            <h3>Heading three</h3>
            <p>Body text. Precise, readable, and human.</p>
            <div className="mono">IBM Plex Mono · 0x83f4…b610</div>
            <div className="metric-value">24,829</div>
          </div>
        </div>
      </Section>
      <Section
        eyebrow="03 / Interaction"
        title="Controls, without distraction."
      >
        <div className="actions">
          <Button>
            Primary <ArrowRight size={16} />
          </Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="three-col control-grid">
          <label className="field">
            Search
            <input
              className="input"
              placeholder="Block, transaction, or address"
            />
          </label>
          <label className="field">
            Token
            <select>
              <option>XRGE</option>
              <option>qETH</option>
            </select>
          </label>
          <label className="field">
            Amount
            <input className="input" type="number" min="0" placeholder="0.00" />
          </label>
        </div>
      </Section>
      <Section eyebrow="04 / Data" title="Clarity at every density.">
        <p>
          Illustrative values below. These are component specimens, not live
          network claims.
        </p>
        <div className="metrics">
          <Metric label="Block height · demo" value="24,829" />
          <Metric label="Validators · demo" value="5" />
          <Metric label="Peers · demo" value="6" />
          <Metric label="Network" value={<Status state="demo" />} />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Block</th>
                <th>Hash</th>
                <th>Transactions</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>#24,829</td>
                <td className="mono">0x83f4…b610</td>
                <td>3</td>
                <td>
                  <Status state="demo">Snapshot</Status>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
      <Section eyebrow="05 / Feedback" title="State is information.">
        <div className="actions">
          {(
            [
              "loading",
              "live",
              "stale",
              "unavailable",
              "demo",
              "warning",
              "error",
            ] as const
          ).map((s) => (
            <Status key={s} state={s} />
          ))}
        </div>
        <div className="two-col control-grid">
          <Surface>
            <h3>Application surface</h3>
            <p>
              Hairline borders. Minimal depth. A 10px corner radius for controls
              and forms.
            </p>
            <Button variant="outline" onClick={() => setOpen(true)}>
              Open modal specimen
            </Button>
          </Surface>
          <Surface>
            <h3>Motion is scarce.</h3>
            <p>
              180ms focus and hover transitions. A modest page entrance.
              Movement follows intention.
            </p>
            <CodeBlock>
              {
                "prefers-reduced-motion: reduce\n→ No decorative movement\n→ No smooth scrolling"
              }
            </CodeBlock>
          </Surface>
        </div>
      </Section>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="A moment of focus"
      >
        <p>
          A native modal traps focus, closes on Escape, and returns focus to its
          trigger.
        </p>
        <Button onClick={() => setOpen(false)}>Close specimen</Button>
      </Dialog>
    </main>
  );
}
