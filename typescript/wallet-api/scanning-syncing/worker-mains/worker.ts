import { scanWithCacheFromSettings } from "../backgroundWorker";
import type { ScanSetting } from "../scanSettings";
declare const wallet_scan_setting: ScanSetting;

await scanWithCacheFromSettings(
  (x) => self.postMessage({ type: "RESULT", payload: x }),
  wallet_scan_setting
);
