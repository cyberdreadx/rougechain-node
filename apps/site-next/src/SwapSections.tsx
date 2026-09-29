import { useDemoWallet, DEMO_SHORT_ADDRESS } from "./wallet/DemoWalletProvider";
import { DemoBadge, Button, EmptyState } from "@rougechain/ui";
export default function SwapSections({
  section,
}: {
  section: "pools" | "positions";
}) {
  const wallet = useDemoWallet();
  return (
    <main id="main" className="app-main">
      <div className="container">
        <div className="app-page-heading">
          <div>
            <div className="eyebrow">Trade / {section}</div>
            <h1>
              {section === "pools" ? "Liquidity pools" : "Your positions"}
            </h1>
            <p>Explore the design. All values and positions are synthetic.</p>
          </div>
          <DemoBadge />
        </div>
        {section === "pools" ? (
          <div className="specimen-grid">
            {["XRGE / qETH", "XRGE / qUSDC"].map((pair) => (
              <article className="surface" key={pair}>
                <h2>{pair}</h2>
                <p>Liquidity — · Volume — · APR —</p>
                <Button disabled variant="outline">
                  Add liquidity unavailable
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              wallet.connected ? "No position data" : "No wallet connected"
            }
          >
            <span>
              {wallet.connected
                ? `Demo account: ${DEMO_SHORT_ADDRESS}. No positions are fetched.`
                : "Preview a shared identity using Connect Wallet in the header."}
            </span>
          </EmptyState>
        )}
      </div>
    </main>
  );
}
