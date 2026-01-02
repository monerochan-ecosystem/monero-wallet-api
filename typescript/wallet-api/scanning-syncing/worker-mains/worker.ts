import { sleep } from "../../io/sleep";
import { scanWallets } from "../backgroundWorker";
declare const scan_settings_path: string;
declare const pathPrefix: string;
while (true) {
  await scanWallets(
    (x) => self.postMessage({ type: "RESULT", payload: x }),
    undefined,
    scan_settings_path,
    pathPrefix
  );
  console.log(
    "no wallets found to scan in wallet settings, trying again in 1 second"
  );
  await sleep(1000);
}
