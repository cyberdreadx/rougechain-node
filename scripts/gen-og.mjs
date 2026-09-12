// Build-time OG image generator. Renders one branded 1200x630 PNG per route
// (scripts/og-routes.mjs) into dist/og/<slug>.png using satori + resvg — pure
// Node, no browser. Runs after `vite build` in the npm build script.
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "./og-routes.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
const outDir = path.join(root, "dist", "og");

const reg = fs.readFileSync(path.join(dir, "og-fonts", "DejaVuSans.ttf"));
const bold = fs.readFileSync(path.join(dir, "og-fonts", "DejaVuSans-Bold.ttf"));

const BG = "#07080d";
const FG = "#e8ecf4";
const DIM = "#8b93a7";
const ACCENTS = { teal: "#22d3c5", purple: "#a855f7", green: "#34d399" };

const div = (style, children) => ({ type: "div", props: { style, children } });

function card({ label, title, subtitle, accent }) {
  const acc = ACCENTS[accent] || ACCENTS.teal;
  return div(
    { display: "flex", flexDirection: "column", width: "1200px", height: "630px", background: BG, fontFamily: "DejaVu" },
    [
      div({ display: "flex", width: "1200px", height: "12px", background: acc }, []),
      div(
        { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", padding: "68px 84px" },
        [
          div({ display: "flex", alignItems: "center", fontSize: "30px", letterSpacing: "6px", color: acc }, [
            div({ display: "flex", width: "20px", height: "20px", borderRadius: "20px", background: acc, marginRight: "16px" }, []),
            div({ display: "flex" }, `ROUGECHAIN · ${label.toUpperCase()}`),
          ]),
          div({ display: "flex", fontSize: "82px", fontWeight: 700, color: FG, marginTop: "28px", lineHeight: 1.05, maxWidth: "1030px" }, title),
          div({ display: "flex", fontSize: "34px", color: DIM, marginTop: "26px", maxWidth: "960px", lineHeight: 1.3 }, subtitle),
        ],
      ),
      div({ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 84px 56px" }, [
        div({ display: "flex", fontSize: "30px", fontWeight: 700, color: FG }, "rougechain.io"),
        div({ display: "flex", fontSize: "26px", color: DIM }, "Post-quantum L1"),
      ]),
    ],
  );
}

fs.mkdirSync(outDir, { recursive: true });
const fonts = [
  { name: "DejaVu", data: reg, weight: 400, style: "normal" },
  { name: "DejaVu", data: bold, weight: 700, style: "normal" },
];

let n = 0;
for (const r of ROUTES) {
  const svg = await satori(card(r), { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  fs.writeFileSync(path.join(outDir, `${r.slug}.png`), png);
  n++;
}
console.log(`[og] generated ${n} OG images → dist/og/`);
