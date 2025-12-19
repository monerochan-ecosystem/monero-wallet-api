import { ViewPair } from "../api";
import { type CacheChangedCallback } from "./scanWithCache";
import {
  readScanSettings,
  readWalletFromScanSettings,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
} from "./scanSettings";
/**
 * scans with cache from settings file (Bun.file uses indexedDB on web,
 * provide Bun.file(), Bun.write() methods + Bun.env according to your platform)
 * throws if no secret_view_key is found in process.env (provide this readonly member according to your platform)
 *
 * if you don't expect your main thread to exit, and this one to stop and be woken up at random times,
 * just use a web worker instead and pass the code to be run to the worker (most likely a call to scanWithCacheFile())
 */
export async function scanWithCacheFromSettings(
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
  if (!walletSettings)
    throw new Error("No wallet settings found for " + primary_address);
  const walletSettingsAndKeys = walletSettingsPlusKeys(walletSettings);
  if (!walletSettingsAndKeys.halted) {
    if (!walletSettingsAndKeys.secret_view_key)
      throw new Error(
        "No secret view key found for " + walletSettings.primary_address
      );
    const viewpair = await ViewPair.create(
      walletSettingsAndKeys.primary_address,
      walletSettingsAndKeys.secret_view_key,
      walletSettingsAndKeys.node_url // TODO: handle failed connections, try different nodeurls
    );
    viewpair.scanWithCacheFile(
      walletSettingsAndKeys.start_height,
      `${walletSettingsAndKeys.primary_address}_cache.json`,
      cacheChanged, // this one should notify over sendMessage, so we need to have it as an argument
      stopSync, // Relevant for MV3 extensions: do we ever need stopsync? no.
      //  if we get the stop message from the sidebar/popup,
      //  and scan settings have been put to halt,
      //  we just dont run this code at all. As it resets our context.
      //  When the service worker resets or terminates,
      //  any ongoing fetch requests are automatically aborted.
      walletSettingsAndKeys.secret_spend_key,
      walletSettingsAndKeys.stop_height
    );
  }
}
//CURRENTTASK: etract the part so we can push in settings
export function startWebworker(worker_script: string) {
  const blob = new Blob([worker_script], {
    type: "application/typescript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return worker;
}

// TODO: do one for ViewPairs / ManyScanCachesOpened
