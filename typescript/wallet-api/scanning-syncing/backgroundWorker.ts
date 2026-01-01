import { ViewPair } from "../api";
import { type CacheChangedCallback } from "./scanresult/scanCache";
import { openNonHaltedWallets, walletSettingsPlusKeys } from "./scanSettings";

export async function scanWallets(
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  stopSync?: AbortSignal,
  scan_settings_path?: string,
  pathPrefix?: string
) {
  const nonHaltedWallets = await openNonHaltedWallets(scan_settings_path);
  const masterWalletSettings = nonHaltedWallets[0];
  const masterWithKeys = walletSettingsPlusKeys(masterWalletSettings);
  const masterViewPair = await ViewPair.create(
    masterWalletSettings.primary_address,
    masterWithKeys.secret_view_key,
    masterWalletSettings.node_url
  );
  await masterViewPair.scan(
    cacheChanged,
    stopSync,
    scan_settings_path,
    pathPrefix
  );
}

export function startWebworker(
  worker_script: string,
  handle_result?: (result: unknown) => void
) {
  const blob = new Blob([WW_ERROR_FORWARDING_SNIPPET + worker_script], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: "module" });
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
