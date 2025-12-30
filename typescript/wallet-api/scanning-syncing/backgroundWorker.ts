import { ViewPair } from "../api";
import type { MasterSlaveInit } from "./scanresult/getBlocksbinBuffer";
import { type CacheChangedCallback } from "./scanresult/scanCache";
import {
  readWalletFromScanSettings,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
  type ScanSetting,
  type ScanSettings,
} from "./scanSettings";
/**
 * scans with cache from settings file (Bun.file uses indexedDB on web,
 * provide Bun.file(), Bun.write() methods + Bun.env according to your platform)
 * throws if no secret_view_key is found in process.env (provide this readonly member according to your platform)
 *
 * if you don't expect your main thread to exit,
 * just use a web worker instead and pass the code to be run to the worker. use scanWithCacheFromSettings
 */
export async function scanWithCacheFromSettingsFile(
  primary_address: string,
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  scan_settings_path?: string, // defaults to SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json"
  stopSync?: AbortSignal // in MV3 extension Background Workers this is not needed (context nuke on every event)
) {
  // polyfill Bun.file and Bun.write with indexedDB, Android local app file storage, what ever your platform is

  const walletSettings = await readWalletFromScanSettings(
    primary_address,
    scan_settings_path
  );
  await scanWithCacheFromSettings(cacheChanged, walletSettings, stopSync);
}
/**
 * scans with cache from settings provided as parameter
 *
 * if you don't expect your main thread to exit,
 * just use a web worker and pass the code to be run to the worker
 * look at the ScanCacheOpened.unpause() method (pass in the settings as json into the worker code snippet template string)
 */
export async function scanWithCacheFromSettings(
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  wallet_scan_setting?: ScanSetting,
  stopSync?: AbortSignal, // in MV3 extension Background Workers this is not needed (context nuke on every event)
  masterSlaveInit?: MasterSlaveInit,
  pathPrefix?: string
) {
  // polyfill Bun.file and Bun.write with indexedDB, Android local app file storage, what ever your platform is
  if (!wallet_scan_setting) throw new Error("No wallet settings found");
  const walletSettingsAndKeys = walletSettingsPlusKeys(wallet_scan_setting);
  if (!walletSettingsAndKeys.halted) {
    if (!walletSettingsAndKeys.secret_view_key)
      throw new Error(
        "No secret view key found for " + wallet_scan_setting.primary_address
      );
    const viewpair = await ViewPair.create(
      walletSettingsAndKeys.primary_address,
      walletSettingsAndKeys.secret_view_key,
      walletSettingsAndKeys.node_url // TODO: handle failed connections, try different nodeurls
    );
    await viewpair.scanWithCacheFile(
      `${walletSettingsAndKeys.primary_address}_cache.json`,
      {
        start_height: walletSettingsAndKeys.start_height,
        cacheChanged, // this one should notify over sendMessage, so we need to have it as an argument
        stopSync, // Relevant for MV3 extensions: do we ever need stopsync? no.
        //  if we get the stop message from the sidebar/popup,
        //  and scan settings have been put to halt,
        //  we just dont run this code at all. As it resets our context.
        //  When the service worker resets or terminates,
        //  any ongoing fetch requests are automatically aborted.
        spend_private_key: walletSettingsAndKeys.secret_spend_key,
      },
      masterSlaveInit,
      pathPrefix
    );
  }
}
export async function scanMultipleWallets(
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  scan_settings: ScanSettings,
  stopSync?: AbortSignal,
  pathPrefix?: string // path prefix for cache + getblocksbin buffer
) {
  if (!scan_settings?.wallets) return undefined;
  const nonHaltedWallets = scan_settings.wallets.filter(
    (wallet) => !wallet?.halted
  );
  if (!nonHaltedWallets.length) return undefined;
  if (nonHaltedWallets.length > 1) {
    const masterWallet = nonHaltedWallets[0];
    let slaveMangers: (() => void)[] = [];

    function foodFromMaster(): Promise<void> {
      return new Promise((resolve) => slaveMangers.push(resolve));
    }

    function masterGotFed(): void {
      slaveMangers.forEach((resolve) => resolve());
      slaveMangers = [];
    }
    const suppliedCallback = cacheChanged;
    const masterCacheChanged: CacheChangedCallback = async (params) => {
      masterGotFed(); // this feeds the slaves, they are waiting for it (will read getblocksbin response from disk / indexeddb)
      if (suppliedCallback) await suppliedCallback(params);
    };
    for (const wallet of nonHaltedWallets.slice(1)) {
      wallet.start_height = masterWallet.start_height;
      scanWithCacheFromSettings(
        cacheChanged,
        wallet,
        stopSync,
        {
          foodFromMaster,
          nonHaltedWallets,
        },
        pathPrefix
      );
    }

    return await scanWithCacheFromSettings(
      masterCacheChanged,
      masterWallet,
      stopSync,
      {
        master: true,
        nonHaltedWallets,
      }
    );
  } else {
    return await scanWithCacheFromSettings(
      cacheChanged,
      nonHaltedWallets[0],
      stopSync
    );
  }
}

export function startWebworker(
  worker_script: string,
  handle_result?: (result: unknown) => void
) {
  const blob = new Blob([WW_ERROR_FORWARDING_SNIPPET + worker_script], {
    type: "application/typescript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  worker.onmessage = (event) => {
    switch (event.data.type) {
      case "RESULT": // Handle normal messages
        if (handle_result) handle_result(event.data.payload);
        break;
      case "ERROR":
        console.error("Worker error:", event.data.payload);
        break;
    }
  };

  return worker;
}

// Autoforward ALL errors with error type (global handlers)
export const WW_ERROR_FORWARDING_SNIPPET = `\n
self.onerror = (e) => self.postMessage({ type: 'ERROR', payload: e.message });
self.addEventListener('unhandledrejection', (e) => 
  self.postMessage({ type: 'ERROR', payload: e.reason })
); \n`;

// TODO: do one for ViewPairs / ManyScanCachesOpened
