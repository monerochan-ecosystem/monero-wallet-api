import {
  ScanCacheOpened,
  type ScanCacheOpenedCreateParams,
} from "./scanresult/scanCacheOpened";
import type { ScanCache } from "./scanresult/scanWithCache";
export async function openWallets() {}
/**
 * Opens a **single wallet** for scanning.
 * **Touches ScanSettings.json** (use `openWallets()` for multiple wallets).
 *
 * Scan runs in a worker thread to not block the main thread.
 *
 * Supports `pause()`, `unpause(node_url)`, and `wallet.node_url = "new_url"` mid-scan.
 *
 * @param primary_address Wallet address
 * @param options Configuration options
 * @returns Promise<ScanCacheOpened>
 */
export async function openWallet(
  primary_address: string,
  options: Omit<ScanCacheOpenedCreateParams, "primary_address" | "cache"> & {
    cache?: ScanCache | string | true;
  } = {}
): Promise<ScanCacheOpened> {
  return await ScanCacheOpened.create({
    primary_address,
    ...options,
    cache: options.cache ?? true, // read from ScanSettings.json (default behavior),
    // if cache instance is provided, in memory only. if path is provided, read from file, both ignore ScanSettings.json
  } as ScanCacheOpenedCreateParams);
}
