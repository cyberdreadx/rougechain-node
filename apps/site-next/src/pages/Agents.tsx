import { useState } from "react";
import { ChevronRight, ExternalLink, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyCode, PageFrame, useRouteSeo } from "./common";

type AgentTool = { name: string; write?: boolean };
/** MCP tool catalogue (names are the server's identifiers; descriptions live in pages.json agents.tools.<name>). */
const TOOL_CATEGORIES: { id: string; tools: AgentTool[] }[] = [
  { id: "keys", tools: [{ name: "generate_wallet" }, { name: "wallet_info" }] },
  { id: "chain", tools: [{ name: "get_chain_stats" }, { name: "get_block" }, { name: "get_latest_blocks" }] },
  {
    id: "wallet",
    tools: [{ name: "get_balance" }, { name: "get_transaction" }, { name: "send_transaction", write: true }, { name: "burn_tokens", write: true }],
  },
  {
    id: "tokens",
    tools: [
      { name: "list_tokens" },
      { name: "get_token" },
      { name: "get_token_holders" },
      { name: "create_token", write: true },
      { name: "mint_tokens", write: true },
      { name: "update_token_metadata", write: true },
      { name: "claim_token_metadata", write: true },
    ],
  },
  {
    id: "defi",
    tools: [
      { name: "list_pools" },
      { name: "get_swap_quote" },
      { name: "swap", write: true },
      { name: "create_pool", write: true },
      { name: "add_liquidity", write: true },
      { name: "remove_liquidity", write: true },
    ],
  },
  {
    id: "nfts",
    tools: [
      { name: "list_nft_collections" },
      { name: "get_nft_collection" },
      { name: "nft_create_collection", write: true },
      { name: "nft_mint", write: true },
      { name: "nft_batch_mint", write: true },
      { name: "nft_transfer", write: true },
      { name: "nft_burn", write: true },
      { name: "nft_lock", write: true },
      { name: "nft_freeze_collection", write: true },
    ],
  },
  {
    id: "staking",
    tools: [{ name: "stake", write: true }, { name: "unstake", write: true }, { name: "request_faucet", write: true }],
  },
  { id: "validators", tools: [{ name: "list_validators" }] },
  {
    id: "contracts",
    tools: [
      { name: "list_contracts" },
      { name: "get_contract" },
      { name: "get_contract_state" },
      { name: "get_contract_events" },
      { name: "query_contract" },
      { name: "get_tx_receipt" },
      { name: "publish_contract", write: true },
      { name: "execute_contract", write: true },
    ],
  },
  {
    id: "social",
    tools: [
      { name: "get_global_timeline" },
      { name: "get_post" },
      { name: "get_user_posts" },
      { name: "get_post_replies" },
      { name: "get_track_stats" },
      { name: "get_artist_stats" },
      { name: "create_post", write: true },
      { name: "delete_post", write: true },
      { name: "repost", write: true },
      { name: "follow", write: true },
      { name: "like_track", write: true },
      { name: "comment_on_track", write: true },
    ],
  },
  { id: "messaging", tools: [{ name: "list_messenger_wallets" }] },
  {
    id: "names",
    tools: [{ name: "resolve_name" }, { name: "reverse_lookup_name" }, { name: "register_name", write: true }, { name: "release_name", write: true }],
  },
  { id: "bridge", tools: [{ name: "bridge_withdraw", write: true }] },
  { id: "governance", tools: [{ name: "list_proposals" }, { name: "get_fee_info" }] },
];

const MCP_URL = "https://modelcontextprotocol.io/";
const INSTALL_CMD = "npm install -g @rougechain/mcp-server";
const FLOW = ["agent", "server", "api", "chain"] as const;
const PROMPTS: [string, boolean][] = [
  ["height", false],
  ["balance", false],
  ["quote", false],
  ["social", false],
  ["launch", true],
  ["deploy", false],
  ["resolve", false],
];
const COMPATIBLE = ["claude", "cursor", "custom"] as const;
const RESOURCES: [string, string][] = [
  ["source", "https://github.com/cyberdreadx/rougechain-node/tree/main/mcp-server"],
  ["docs", "https://docs.rougechain.io/advanced/mcp-server.html"],
  ["sdk", "https://www.npmjs.com/package/@rougechain/sdk"],
  ["spec", "https://modelcontextprotocol.io/"],
];

const TOTAL = TOOL_CATEGORIES.reduce((n, c) => n + c.tools.length, 0);
const WRITES = TOOL_CATEGORIES.reduce((n, c) => n + c.tools.filter((x) => x.write).length, 0);

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
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.agents.title"), description: t("seo.agents.description") });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <PageFrame
      eyebrow={t("agents.eyebrow")}
      title={t("agents.title")}
      aside={<span className="pill">MCP</span>}
      lead={
        <>
          {t("agents.lead")}{" "}
          <a className="text-link inline" href={MCP_URL} target="_blank" rel="noopener noreferrer">
            modelcontextprotocol.io
          </a>
        </>
      }
    >
      <section className="rc-block" aria-labelledby="how">
        <h2 id="how">{t("agents.howTitle")}</h2>
        <ol className="rc-flow">
          {FLOW.map((k) => (
            <li key={k} className="surface">
              <strong>{t(`agents.flow.${k}.label`)}</strong>
              <small>{t(`agents.flow.${k}.sub`, { count: TOTAL })}</small>
            </li>
          ))}
        </ol>
        <p className="muted">{t("agents.flowNote")}</p>
      </section>

      <section className="rc-block" aria-labelledby="tools">
        <h2 id="tools">{t("agents.toolsTitle")}</h2>
        <p className="muted">{t("agents.toolsLead", { total: TOTAL, cats: TOOL_CATEGORIES.length, read: TOTAL - WRITES, write: WRITES })}</p>
        <div className="rc-tool-grid">
          {TOOL_CATEGORIES.map((cat) => {
            const expanded = open === cat.id;
            const id = `tools-${cat.id}`;
            return (
              <div key={cat.id} className={`surface rc-tool-cat${expanded ? " open" : ""}`}>
                <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(expanded ? null : cat.id)}>
                  <span>
                    <strong>{t(`agents.categories.${cat.id}`)}</strong>
                    <small>{t("agents.toolsCount", { count: cat.tools.length })}</small>
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
                            <Lock size={10} aria-hidden="true" /> {t("agents.signsTx")}
                          </span>
                        )}
                        <span className="muted"> — {t(`agents.tools.${tool.name}`)}</span>
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
        <h2 id="quick">{t("agents.quickTitle")}</h2>
        <ol className="rc-steps numbered">
          <li className="surface">
            <strong>{t("agents.install")}</strong>
            <CopyCode text={INSTALL_CMD} />
            <p>{t("agents.installNote")}</p>
          </li>
          <li className="surface">
            <strong>{t("agents.configTitle")}</strong>
            <p>
              {t("agents.readOnly")} · <span className="pill">{t("agents.recommended")}</span>
            </p>
            <CopyCode text={configRead} label={t("agents.configLabel")} />
            <p>
              {t("agents.readWrite")} ·{" "}
              <span className="rc-write">
                <Lock size={10} aria-hidden="true" /> {t("agents.signsTx")}
              </span>
            </p>
            <CopyCode text={configWrite} label={t("agents.configLabel")} />
            <p>{t("agents.writeNote", { count: WRITES })}</p>
          </li>
          <li className="surface">
            <strong>{t("agents.talkTitle")}</strong>
            <ul className="rc-prompts">
              {PROMPTS.map(([p, write]) => (
                <li key={p}>
                  <q>{t(`agents.prompts.${p}`)}</q>
                  {write && <small className="rc-write">{t("agents.needsWallet")}</small>}
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </section>

      <section className="rc-block" aria-labelledby="compat">
        <h2 id="compat">{t("agents.compatibleTitle")}</h2>
        <div className="rc-cards three">
          {COMPATIBLE.map((k) => (
            <article key={k} className="surface rc-card">
              <div className="field-row">
                <h3>{t(`agents.compatible.${k}.name`)}</h3>
                <span className="status live">{t("agents.supported")}</span>
              </div>
              <p>{t(`agents.compatible.${k}.desc`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="rc-block" aria-labelledby="res">
        <h2 id="res">{t("agents.resourcesTitle")}</h2>
        <div className="rc-cards two">
          {RESOURCES.map(([k, href]) => (
            <a key={href} className="surface rc-card rc-link-card" href={href} target="_blank" rel="noopener noreferrer">
              <span>
                <strong>{t(`agents.resources.${k}.title`)}</strong>
                <small>{t(`agents.resources.${k}.sub`)}</small>
              </span>
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
