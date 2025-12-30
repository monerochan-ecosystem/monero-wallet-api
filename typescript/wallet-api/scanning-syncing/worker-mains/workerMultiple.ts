import { scanMultipleWallets } from "../backgroundWorker";
import type { ScanSettings } from "../scanSettings";
declare const scan_settings: ScanSettings;

await scanMultipleWallets(
  (x) => self.postMessage({ type: "RESULT", payload: x }),
  scan_settings
);
