export type Hex = string;

export interface ChainConfig {
  chainId: string;
  genesisTime: number;
  blockTimeMs: number;
}

export interface TxV1 {
  version: 1;
  type: "transfer" | "stake" | "unstake";
  fromPubKey: Hex; // ML-DSA public key (hex)
  nonce: number;
  payload: unknown;
  fee: number;
  sig: Hex; // signature over canonical tx bytes (hex)
}

export interface BlockHeaderV1 {
  version: 1;
  chainId: string;
  height: number;
  time: number; // unix ms
  prevHash: Hex; // 32-byte sha256 hex
  txHash: Hex; // sha256 of canonical tx list bytes
  proposerPubKey: Hex;
}

export interface BlockV1 {
  version: 1;
  header: BlockHeaderV1;
  txs: TxV1[];
  proposerSig: Hex; // ML-DSA signature over canonical header bytes
  hash: Hex; // sha256(headerBytes || proposerSigBytes)
}

export type P2PMessage =
  | { type: "HELLO"; nodeId: string; chainId: string; height: number }
  | { type: "GET_TIP" }
  | { type: "TIP"; height: number; hash: Hex }
  | { type: "GET_BLOCK"; height: number }
  | { type: "BLOCK"; block: BlockV1 }
  | { type: "TX"; tx: TxV1 };

