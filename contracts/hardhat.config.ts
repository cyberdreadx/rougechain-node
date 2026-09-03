import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const _RAW_DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || "").trim();
// Accept the key with or without a 0x prefix (hardhat/ethers require 0x).
const DEPLOYER_KEY = _RAW_DEPLOYER_KEY
    ? (_RAW_DEPLOYER_KEY.startsWith("0x") ? _RAW_DEPLOYER_KEY : "0x" + _RAW_DEPLOYER_KEY)
    : "";

const config: HardhatUserConfig = {
    solidity: "0.8.20",
    networks: {
        baseSepolia: {
            url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
            accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
            chainId: 84532,
        },
        base: {
            url: process.env.BASE_RPC || "https://mainnet.base.org",
            accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
            chainId: 8453,
            gasPrice: "auto",
        },
    },
    etherscan: {
        apiKey: {
            baseSepolia: process.env.BASESCAN_API_KEY || "",
            base: process.env.BASESCAN_API_KEY || "",
        },
        customChains: [
            {
                network: "baseSepolia",
                chainId: 84532,
                urls: {
                    apiURL: "https://api-sepolia.basescan.org/api",
                    browserURL: "https://sepolia.basescan.org",
                },
            },
            {
                network: "base",
                chainId: 8453,
                urls: {
                    apiURL: "https://api.basescan.org/api",
                    browserURL: "https://basescan.org",
                },
            },
        ],
    },
};

export default config;
