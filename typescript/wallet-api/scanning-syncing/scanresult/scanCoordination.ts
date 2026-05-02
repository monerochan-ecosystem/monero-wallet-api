import { ViewPair, type GetBlocksBinBufferItem } from "../../api";
import { type WorkItem, makeWorkItem } from "./scanLoop";
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
/**
 * called when the blocks buffer generator yields "blocks_buffer_changed".
 * removes orphaned work items whose batch is no longer in the blocks buffer,
 * then adds new work items for blocks buffer items not yet referenced.
 */
export function reconcileBlocksBufferChanged(
  blocksBuffer: GetBlocksBinBufferItem[],
  workItemBuffer: WorkItem[],
  scanCache?: ScanCache,
  primaryAddress?: string,
  from?: number,
  to?: number,
): void {
  // remove work items whose batch is no longer in the blocks buffer
  for (let i = workItemBuffer.length - 1; i >= 0; i--) {
    const stillInBlocksBuffer = blocksBuffer.some(
      (b) => b.local_uuid === workItemBuffer[i].batch.local_uuid,
    );
    if (!stillInBlocksBuffer) {
      //TODO when we add CPU workers we should send cancel events here
      workItemBuffer.splice(i, 1);
    }
  }

  // add work items for blocks buffer items not yet referenced
  if (!scanCache || !primaryAddress) return;
  for (const batch of blocksBuffer) {
    const alreadyReferenced = workItemBuffer.some(
      (w) => w.batch.local_uuid === batch.local_uuid,
    );
    if (!alreadyReferenced) {
      //TODO splice the work in smaller chunks
      //TODO asign work to CPU workers, or should they pull?
      workItemBuffer.push(
        makeWorkItem(
          scanCache,
          batch,
          primaryAddress,
          from ?? 0,
          to ?? batch.get_blocks_result_meta.block_infos.length,
        ),
      );
    }
  }
}

/**
 * called when a work item at the left end of the work buffer is done.
 * shifts done items off the left, and removes their batch from the
 * blocks buffer if no remaining work items reference it.
 */
export function reconcileWorkItemDone(
  blocksBuffer: GetBlocksBinBufferItem[],
  workItemBuffer: WorkItem[],
): void {
  while (workItemBuffer.length > 0 && workItemBuffer[0].done) {
    const removed = workItemBuffer.shift()!;
    const stillReferenced = workItemBuffer.some(
      (w) => w.batch.local_uuid === removed.batch.local_uuid,
    );
    if (!stillReferenced) {
      const idx = blocksBuffer.findIndex(
        (b) => b.local_uuid === removed.batch.local_uuid,
      );
      //TODO this really means we have to save work items scanCache to file
      // before setting done = true
      if (idx !== -1) blocksBuffer.splice(idx, 1);
    }
  }
}
