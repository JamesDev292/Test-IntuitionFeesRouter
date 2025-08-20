import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-toolbox"
import * as dotenv from "dotenv"
dotenv.config()

const shouldFork = !!process.env.RPC_FORK_URL && process.env.FORK === "1";

const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  typechain: { target: "ethers-v6" },
  networks: {
    hardhat: shouldFork
      ? { forking: { url: process.env.RPC_FORK_URL! } }
      : {}
  },
  mocha: { timeout: 120_000 } // safe marge si tu veux
};
export default config;
