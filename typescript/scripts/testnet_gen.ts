#!/usr/bin/env bun
import { get_info } from "../wallet-api/api";
import { writeTestnetSpendViewKeysToDotEnvLocal } from "../wallet-api/keypairs-seeds/writeKeypairs";
import { LOCAL_NODE_DEFAULT_URL } from "../wallet-api/node-interaction/nodeUrl";
import { writeWalletToScanSettings } from "../wallet-api/scanning-syncing/scanSettings";

// adds a wallet entry to TestnetScanSettings.json

// will make new spend keys if no Bun.env["sk"] is present

// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env.local for testnet

// optional first arg is the path to custom location for settings file: scripts/testnet_gen.ts  mysettings.json
const height = (await get_info(LOCAL_NODE_DEFAULT_URL)).height;

const primary_address = await writeTestnetSpendViewKeysToDotEnvLocal(
  Bun.env["sk"]
);

await writeWalletToScanSettings({
  primary_address,
  start_height: height,
  scan_settings_path: Bun.argv[2] || "TestnetScanSettings.json",
});

console.log("mine on testnet to:\n", primary_address);
