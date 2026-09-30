import { useState } from "react";
import { ChevronRight, ExternalLink, Lock } from "lucide-react";
import { CopyCode, PageFrame, useRouteSeo } from "./common";
import { agentToolCategories, agents as t, seo } from "./strings";

const TOTAL = agentToolCategories.reduce((n, c) => n + c.tools.length, 0);
const WRITES = agentToolCategories.reduce((n, c) => n + c.tools.filter((x) => x.write).length, 0);

const configRead = `{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io"
      }
    }
  }
}`;

// Same server, plus a wallet — unlocks the signed write tools.
const configWrite = `{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io",
        "ROUGECHAIN_MNEMONIC": "your twenty four word seed phrase here ..."
      }
    }
  }
}`;

export default function Agents() {
  useRouteSeo(seo.agents);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <PageFrame
      eyebrow={t.eyebrow}
      title={t.title}
      aside={<span className="pill">MCP</span>}
      lead={
        <>
          {t.lead}{" "}
          <a className="text-link inline" href={t.mcpUrl} target="_blank" rel="noopener noreferrer">
            modelcontextprotocol.io
          </a>
        </>
      }
    >
      <section className="rc-block" aria-labelledby="how">
        <h2 id="how">{t.howTitle}</h2>
        <ol className="rc-flow">
          {t.flow.map(([label, sub]) => (
            <li key={label} className="surface">
              <strong>{label}</strong>
              <small>{sub.replace("{n}", String(TOTAL))}</small>
            </li>
          ))}
        </ol>
        <p className="muted">{t.flowNote}</p>
      </section>

      <section className="rc-block" aria-labelledby="tools">
        <h2 id="tools">{t.toolsTitle}</h2>
        <p className="muted">{t.toolsLead(TOTAL, agentToolCategories.length, TOTAL - WRITES, WRITES)}</p>
        <div className="rc-tool-grid">
          {agentToolCategories.map((cat) => {
            const expanded = open === cat.title;
            const id = `tools-${cat.title.replace(/\W+/g, "-")}`;
            return (
              <div key={cat.title} className={`surface rc-tool-cat${expanded ? " open" : ""}`}>
                <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(expanded ? null : cat.title)}>
                  <span>
                    <strong>{cat.title}</strong>
                    <small>{t.toolsCount(cat.tools.length)}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
                {expanded && (
                  <ul id={id}>
                    {cat.tools.map((tool) => (
                      <li key={tool.name}>
                        <code className="mono">{tool.name}</code>
                        {tool.write && (
                          <span className="rc-write">
                            <Lock size={10} aria-hidden="true" /> {t.signsTx}
                          </span>
                        )}
                        <span className="muted"> — {tool.desc}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rc-block" aria-labelledby="quick">
        <h2 id="quick">{t.quickTitle}</h2>
        <ol className="rc-steps numbered">
          <li className="surface">
            <strong>{t.install}</strong>
            <CopyCode text={t.installCmd} />
            <p>{t.installNote}</p>
          </li>
          <li className="surface">
            <strong>{t.configTitle}</strong>
            <p>
              {t.readOnly} · <span className="pill">{t.recommended}</span>
            </p>
            <CopyCode text={configRead} label="config" />
            <p>
              {t.readWrite} ·{" "}
              <span className="rc-write">
                <Lock size={10} aria-hidden="true" /> {t.signsTx}
              </span>
            </p>
            <CopyCode text={configWrite} label="config" />
            <p>{t.writeNote(WRITES)}</p>
          </li>
          <li className="surface">
            <strong>{t.talkTitle}</strong>
            <ul className="rc-prompts">
              {t.prompts.map(([p, write]) => (
                <li key={p}>
                  <q>{p}</q>
                  {write && <small className="rc-write">{t.needsWallet}</small>}
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </section>

      <section className="rc-block" aria-labelledby="compat">
        <h2 id="compat">{t.compatibleTitle}</h2>
        <div className="rc-cards three">
          {t.compatible.map(([name, desc]) => (
            <article key={name} className="surface rc-card">
              <div className="field-row">
                <h3>{name}</h3>
                <span className="status live">{t.supported}</span>
              </div>
              <p>{desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="rc-block" aria-labelledby="res">
        <h2 id="res">{t.resourcesTitle}</h2>
        <div className="rc-cards two">
          {t.resources.map(([title, sub, href]) => (
            <a key={href} className="surface rc-card rc-link-card" href={href} target="_blank" rel="noopener noreferrer">
              <span>
                <strong>{title}</strong>
                <small>{sub}</small>
              </span>
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
