import { Navigate, Route } from "react-router-dom";
import Overview from "./Overview";
import {
  BlocksPage,
  ContractsPage,
  NftsPage,
  TokensPage,
  TransactionsPage,
} from "./Lists";
import { BlockDetailPage, TxDetailPage } from "./BlockTx";
import {
  AddressDetailPage,
  ContractDetailPage,
  NftCollectionPage,
  TokenDetailPage,
} from "./Entities";

/**
 * Explorer routes. The legacy rougechain.io paths are kept exactly so existing links and the
 * future explorer.rougechain.io redirects keep working; /explorer/* are the POC's section paths.
 */
export const EXPLORER_PREFIXES = [
  "/explorer",
  "/blockchain",
  "/transactions",
  "/block",
  "/tx",
  "/address",
  "/tokens",
  "/token",
  "/nfts",
  "/contracts",
  "/contract",
];

export function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isExplorerPath(pathname: string) {
  return EXPLORER_PREFIXES.some((p) => matchesPrefix(pathname, p));
}

export const explorerRoutes = [
  <Route key="explorer" path="/explorer" element={<Overview />} />,
  <Route key="blockchain" path="/blockchain" element={<Overview />} />,
  <Route key="blocks" path="/explorer/blocks" element={<BlocksPage />} />,
  <Route
    key="transactions"
    path="/transactions"
    element={<TransactionsPage />}
  />,
  <Route key="block" path="/block/:height" element={<BlockDetailPage />} />,
  <Route key="tx" path="/tx/:hash" element={<TxDetailPage />} />,
  <Route
    key="address"
    path="/address/:pubkey"
    element={<AddressDetailPage />}
  />,
  <Route key="tokens" path="/tokens" element={<TokensPage />} />,
  <Route key="token" path="/token/:symbol" element={<TokenDetailPage />} />,
  <Route key="nfts" path="/nfts" element={<NftsPage />} />,
  <Route
    key="nft"
    path="/nfts/:collectionId"
    element={<NftCollectionPage />}
  />,
  <Route key="contracts" path="/contracts" element={<ContractsPage />} />,
  <Route
    key="contract"
    path="/contract/:addr"
    element={<ContractDetailPage />}
  />,
  // POC section paths now point at the real pages.
  ...["transactions", "tokens", "nfts", "contracts"].map((s) => (
    <Route
      key={`poc-${s}`}
      path={`/explorer/${s}`}
      element={<Navigate replace to={`/${s}`} />}
    />
  )),
];
