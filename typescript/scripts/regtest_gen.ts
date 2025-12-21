#!/usr/bin/env bun
import { get_info } from "../wallet-api/api";
import { writeRegtestSpendViewKeysToDotEnvTestLocal } from "../wallet-api/keypairs-seeds/writeKeypairs";
import { LOCAL_NODE_DEFAULT_URL } from "../wallet-api/node-interaction/nodeUrl";
import { writeWalletToScanSettings } from "../wallet-api/scanning-syncing/scanSettings";

// adds a wallet entry to RegtestScanSettings.json

// will make new spend keys if no Bun.env["sk"] is present

// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env.test.local for regtest

// optional first arg is the path to custom location for settings file: scripts/regtest_gen.ts  mysettings.json
const height = (await get_info(LOCAL_NODE_DEFAULT_URL)).height;

const primary_address = await writeRegtestSpendViewKeysToDotEnvTestLocal(
  Bun.env["sk"]
);

await writeWalletToScanSettings({
  primary_address,
  start_height: height,
  scan_settings_path: Bun.argv[2] || "RegtestScanSettings.json",
});

console.log("mine on regtest to:\n", primary_address);
