import { ViewPair } from "../api";
import {
  readScanSettings,
  scanSettingsStoreNameDefault,
  type CacheChangedCallback,
} from "./scanWithCache";
export async function scanWithCacheFromSettings(
  cacheChanged: CacheChangedCallback = (...args) => console.log(args),
  settingsStorePath: string = scanSettingsStoreNameDefault,
  settingsIndex: number = 0, // which wallet in the Settings wallets array do you want to scan
  nodeUrlIndex: number = 0, // which nodeurl in the Settings nodeurls array do you want to use
  stopSync?: AbortSignal // in MV3 extension Background Workers this is not needed (context nuke on every event)
) {
  // polyfill Bun.file and Bun.write with indexedDB, Android local app file storage, what ever your platform is
  const scanSettings = await readScanSettings(settingsStorePath); // TODO adapt this function to read secrets from .env (see other todos here)
  if (!scanSettings) return;

  const walletSettings = scanSettings.wallets[settingsIndex];
  if (walletSettings && !walletSettings.halted) {
    const viewpair = await ViewPair.create(
      walletSettings.primary_address,
      walletSettings.secret_view_key!, //TODO read this from .env.local if not in browser
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
      walletSettings.spend_private_key, //TODO read this from .env.local if not in browser
      walletSettings.stop_height
    );
  }
}
// TODO: replace this part with ViewPairs once the viewpairs.scanWithCacheFile method is finished
