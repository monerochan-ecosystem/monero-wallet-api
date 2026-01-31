import {
  ManyScanCachesOpened,
  ScanCacheOpened,
  type ManyScanCachesOpenedCreateOptions,
} from "./scanresult/scanCacheOpened";
import {
  openScanSettingsFile,
  writeWalletToScanSettings,
} from "./scanSettings";
/**
 * Opens all **non halted wallets listed in ScanSettings.json** for scanning.
 *
 * @param options.scan_settings_path if you want to use a different settings file other than the default "ScanSettings.json"
 * @param options.pathPrefix if you want to keep wallet scan caches, getblocksbinbuffer in a different directory
 * @param options.no_worker to feed the ManyScanCachesOpened manually with .feed(params) from CacheChangedCallbackParams
 * @param options.no_stats to disable creation of stats file with aggregated information e.g. amount per wallet / subaddress
 * @param options.notifyMasterChanged pass the output of this to another (no_worker) instance to feed
 * @returns Promise<ManyScanCachesOpened>
 */
export async function openWallets(options?: ManyScanCachesOpenedCreateOptions) {
  return await ManyScanCachesOpened.create(options ?? {});
}
/**
 * Opens a **single wallet** for scanning.
 * **Touches ScanSettings.json**,
 *  halts all other wallets and scans only this wallet (use `openWallets()` for scanning all non halted wallets in the settings file).
 *
 * Scan runs in a worker thread to not block the main thread.
 *
 * @param primary_address Wallet address
 * @param scan_settings_path if you want to use a different settings file other than the default "ScanSettings.json"
 * @param pathPrefix if you want to keep wallet scan caches, getblocksbinbuffer in a different directory
 * @param no_worker to feed the ManyScanCachesOpened manually with .feed(params) from CacheChangedCallbackParams
 * @param options.no_stats to disable creation of stats file with aggregated information e.g. amount per wallet / subaddress
 * @returns Promise<ScanCacheOpened>
 */
export async function openWallet(
  primary_address: string,
  scan_settings_path?: string,
  pathPrefix?: string,
  no_worker?: boolean,
  no_stats?: boolean,
): Promise<ScanCacheOpened> {
  await haltAllWalletsExcept(primary_address, scan_settings_path);
  return await ScanCacheOpened.create({
    primary_address,
    scan_settings_path,
    pathPrefix,
    no_worker,
    no_stats,
  });
}

export async function haltAllWalletsExcept(
  primary_address: string,
  scan_settings_path?: string,
) {
  const scan_settings = await openScanSettingsFile(scan_settings_path);
  if (!scan_settings?.wallets) return;
  const nonHaltedWallets = scan_settings.wallets.filter(
    (wallet) => !wallet?.halted,
  );
  for (const wallet of nonHaltedWallets) {
    await writeWalletToScanSettings({
      primary_address: wallet.primary_address, // halt all wallets
      halted: true,
      scan_settings_path,
    });
  }
  await writeWalletToScanSettings({
    primary_address, // unhalt this wallet
    halted: false,
    scan_settings_path,
  });
}
