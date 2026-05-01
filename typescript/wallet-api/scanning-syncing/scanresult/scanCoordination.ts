import { ViewPair } from "../../api";
import {
  cullTooLargeScanHeight,
  getNonHaltedWallets,
  openScanSettingsFile,
  walletSettingsPlusKeys,
} from "../scanSettings";
import {
  findRange,
  initScanCache,
  readCacheFileDefaultLocation,
  type CacheRange,
  type ScanCache,
} from "./scanCache";
export type WorkToBeDone = {
  start_height: number;
  wallet_caches: ScanCache[];
  anchor_range?: CacheRange;
};
/**
 * this depends only on ScanSettings.json start_height and wallet caches scanned_ranges
 * side effect: will init wallet cache file if it does not exist
 * @param scan_settings_path
 */
export async function findWorkToBeDone(
  scan_settings_path: string,
  pathPrefix?: string,
): Promise<WorkToBeDone | false> {
  const parts = scan_settings_path.split("/");
  const basename = parts.pop()!;
  const dir = parts.join("/");
  const prefix = dir ? `${dir}/` : "";

  const scanSettings = await openScanSettingsFile(scan_settings_path);
  if (!scanSettings) return false;
  const total_start_height = await cullTooLargeScanHeight(
    scanSettings.node_url,
    scan_settings_path,
  );
  const wallets = getNonHaltedWallets(scanSettings);
  if (!wallets.length) return false;
  const potential_anchor_ranges: CacheRange[] = [];
  const wallet_caches: ScanCache[] = [];
  for (const wallet of wallets) {
    let walletCache = await readCacheFileDefaultLocation(
      wallet.primary_address,
      pathPrefix ?? prefix,
    );
    if (!walletCache) {
      const walletSettingsWithKeys = await walletSettingsPlusKeys({
        ...wallet,
        node_url: scanSettings.node_url,
        start_height: total_start_height,
      });
      const newWalletViewPair = await ViewPair.create(
        wallet.primary_address,
        walletSettingsWithKeys.secret_view_key,
        wallet.subaddress_index,
        walletSettingsWithKeys.node_url,
      );
      await initScanCache(
        newWalletViewPair,
        total_start_height,
        scan_settings_path,
        pathPrefix ?? prefix,
      );
      walletCache = await readCacheFileDefaultLocation(
        wallet.primary_address,
        pathPrefix ?? prefix,
      );
      if (!walletCache)
        throw new Error(
          "wallet cache not found and new one could not be created for " +
            wallet.primary_address,
        );
    }
    wallet_caches.push(walletCache);
    const range = findRange(walletCache.scanned_ranges, total_start_height);
    if (!range) continue;
    potential_anchor_ranges.push(range);
  }
  if (!potential_anchor_ranges.length)
    return {
      wallet_caches,
      start_height: total_start_height,
    };
  const anchor_range = potential_anchor_ranges.reduce((a, b) =>
    a.end < b.end ? a : b,
  );
  const start_height = anchor_range.end;

  //  connection settings scanned_ranges is reset on every scan
  // (done in setupBlocksBufferGenerator init)
  // ( they cant they contain newer ranges then resulting start height after
  // lowest fast forward start height on all wallets )
  return {
    wallet_caches,
    start_height,
    anchor_range,
  };
}
