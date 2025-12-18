import { ViewPair } from "../api";
import { type CacheChangedCallback } from "./scanWithCache";
import { readScanSettings, scanSettingsStoreNameDefault } from "./scanSettings";
/**
 * scans with cache from settings file (Bun.file uses indexedDB on web,
 * provide Bun.file(), Bun.write() methods + Bun.env according to your platform)
 * throws if no secret_view_key is found in process.env (provide this readonly member according to your platform)
 */
export async function scanWithCacheFromSettings(
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  settingsStorePath: string = scanSettingsStoreNameDefault,
  settingsIndex: number = 0, // which wallet in the Settings wallets array do you want to scan
  nodeUrlIndex: number = 0, // which nodeurl in the Settings nodeurls array do you want to use
  stopSync?: AbortSignal // in MV3 extension Background Workers this is not needed (context nuke on every event)
) {
  // polyfill Bun.file and Bun.write with indexedDB, Android local app file storage, what ever your platform is
  const scanSettings = await readScanSettings(settingsStorePath);
  if (!scanSettings) return;

  const walletSettings = scanSettings.wallets[settingsIndex];
  if (walletSettings && !walletSettings.halted) {
    if (!walletSettings.secret_view_key)
      throw new Error(
        "No secret view key found for " + walletSettings.primary_address
      );
    const viewpair = await ViewPair.create(
      walletSettings.primary_address,
      walletSettings.secret_view_key,
      scanSettings.node_urls[nodeUrlIndex] // TODO: handle failed connections, try different nodeurls
    );
    viewpair.scanWithCacheFile(
      walletSettings.start_height,
      `${walletSettings.primary_address}_cache.json`,
      cacheChanged, // this one should notify over sendMessage, so we need to have it as an argument
      stopSync, // Relevant for MV3 extensions: do we ever need stopsync? no.
      //  if we get the stop message from the sidebar/popup,
      //  and scan settings have been put to halt,
      //  we just dont run this code at all. As it resets our context.
      //  When the service worker resets or terminates,
      //  any ongoing fetch requests are automatically aborted.
      walletSettings.spend_private_key,
      walletSettings.stop_height
    );
  }
}
// TODO: replace this part with ViewPairs once the viewpairs.scanWithCacheFile method is finished
