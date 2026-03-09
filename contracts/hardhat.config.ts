import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

const config: HardhatUserConfig = {
    solidity: "0.8.20",
    networks: {
        baseSepolia: {
            url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
            accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
            chainId: 84532,
        },
    },
    etherscan: {
        apiKey: {
            baseSepolia: process.env.BASESCAN_API_KEY || "",
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
        ],
    },
};

export default config;
