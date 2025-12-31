import { scanWallets } from "../backgroundWorker";
declare const scan_settings_path: string;
declare const pathPrefix: string;

await scanWallets(
  (x) => self.postMessage({ type: "RESULT", payload: x }),
  undefined,
  scan_settings_path,
  pathPrefix
);
