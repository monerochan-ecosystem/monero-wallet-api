import { scanWithCacheFromSettings } from "../backgroundWorker";
import type { ScanSetting } from "../scanSettings";
declare const scan_settings: ScanSetting;

await scanWithCacheFromSettings(
  (x) => self.postMessage({ type: "RESULT", payload: x }),
  scan_settings
);
