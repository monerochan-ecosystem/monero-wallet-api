import { ViewPair } from "../../api";
import {
  cullTooLargeScanHeight,
  getNonHaltedWallets,
  openScanSettingsFile,
  walletSettingsPlusKeys,
} from "../scanSettings";
import {
  findRange,
  initScanCacheFile,
  type CacheRange,
  type ScanCache,
} from "./scanCache";
export type WalletConfig = {
  primary_address: string;
  secret_view_key: string;
  secret_spend_key?: string;
  subaddress_index: number;
};
export type WorkToBeDone = {
  start_height: number;
  wallet_caches: ScanCache[];
  wallet_configs: WalletConfig[];
  anchor_range?: CacheRange;
};
/**
 * this depends only on ScanSettings.json start_height and wallet caches scanned_ranges
 * side effect: will init wallet cache file if it does not exist
 * side effect: will merge scan ranges + add subaddreses to existing cache files
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
  const wallet_configs: WalletConfig[] = [];
  for (const wallet of wallets) {
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
    const walletCache = await initScanCacheFile(
      newWalletViewPair,
      scan_settings_path,
      pathPrefix ?? prefix,
    );

    if (!walletCache)
      throw new Error(
        "wallet cache not found and new one could not be created for " +
          wallet.primary_address,
      );

    wallet_caches.push(walletCache);
    wallet_configs.push({
      primary_address: wallet.primary_address,
      secret_view_key: walletSettingsWithKeys.secret_view_key,
      secret_spend_key: walletSettingsWithKeys.secret_spend_key,
      subaddress_index: wallet.subaddress_index || 0,
    });
    const range = findRange(walletCache.scanned_ranges, total_start_height);
    if (!range) continue;
    potential_anchor_ranges.push(range);
  }
  if (!potential_anchor_ranges.length)
    return {
      wallet_configs,
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
    wallet_configs,
    wallet_caches,
    start_height,
    anchor_range,
  };
}
//TODO copy the helper from the scanLoop integration test here and use it in the coordinator main
//TODO add workitembuffer and blockbuffer reconciliation functions here
