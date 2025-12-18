// write testnet keys .env.local
// write stagenet keys .env
// write mainnet keys to stdout can > redirect to the place of your desires
// (but you really shouldnt, use a seedphrase instead)

import { writeScanSettings } from "../api";
import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import {
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  writeWalletToScanSettings,
} from "../scanning-syncing/scanSettings";
import { makeSpendKey, makeViewKey } from "./keypairs";

export const stagenet_pk_path = ".env";
export const testnet_pk_path = ".env.local";

// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env for stagenet
export async function writeStagenetSpendViewKeysToDotEnv(spend_key?: string) {
  spend_key = spend_key || (await makeSpendKey());
  let view_pair = await makeViewKey(spend_key);
  let primary_address = view_pair.stagenet_primary;
  await writeEnvLineToDotEnvRefresh(
    `vk${primary_address}`,
    view_pair.view_key,
    stagenet_pk_path
  );
  await writeEnvLineToDotEnvRefresh(
    `sk${primary_address}`,
    spend_key,
    stagenet_pk_path
  );

  return primary_address;
}
// if you want to feed current_height use: (await get_info(node_url)).height
export async function initScanSettings(
  primary_address: string,
  start_height: number, // current height of stagenet dec 18 2025 will be set used as default if not provided
  halted?: boolean,
  stop_height?: number | null,
  node_url: string = LOCAL_NODE_DEFAULT_URL, // initial node url
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT // write your settings to a different path
) {
  const scan_settings_string = await Bun.file(scan_settings_path)
    .text()
    .catch(() => {})
    .then((c) => c || null);

  if (!scan_settings_string) {
    // case: no scan settings exist yet
    const len = await writeScanSettings(
      {
        wallets: [
          {
            primary_address,
            start_height: start_height,
            halted,
            stop_height,
          },
        ],
        node_urls: [node_url],
      },
      scan_settings_path
    );
  } else {
    writeWalletToScanSettings({
      primary_address,
      start_height,
      halted,
      stop_height,
      scan_settings_path,
    });
  }
}

// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env.local for testnet
export async function writeTestnetSpendViewKeysToDotEnvLocal() {
  // TODO
  //writeEnvLineToDotEnvRefresh();
}
// this should be used in a web backend that does (non custodial) scanning
// to add new view / spend keys, received from the users without a restart.
export async function writeEnvLineToDotEnvRefresh(
  key: string,
  value: string,
  path: string = ".env"
) {
  await writeEnvLineToDotEnv(key, value, path);
  Bun.env[key.trim()] = value.trim();
}

// assuming Bun.file + Bun.write are filled in or available natively,
// this is also used by io/indexedDB.ts
export async function writeEnvLineToDotEnv(
  key: string,
  value: string,
  path: string = ".env"
) {
  // this file should be treated as ephemeral
  // private spendkeys + viewkeys are deterministically derived from seedphrase and password
  // specific to indexedDB, browser extentension use case: Bun.env = .env contents
  //
  // we have to go through indexedDB just so the background worker has access to this.
  // (after waking up from an alarm or onmessage event)
  const file = Bun.file(path);
  const content = await file
    .text()
    .catch(() => {})
    .then((c) => c || "");
  const lines = content.split("\n");

  const idx = lines.findIndex((line) => line.startsWith(key));
  const updatedLines =
    idx === -1
      ? [...lines, `${key.trim()}=${value.trim()}`]
      : lines.with(idx, `${key.trim()}=${value.trim()}`);

  await Bun.write(".env", updatedLines.join("\n"));
}

export const STAGENET_FRESH_WALLET_HEIGHT_DEFAULT = 2014841; // current height of stagenet dec 18 2025,
