import {
  setupBlocksBufferGenerator,
  ViewPair,
  type GetBlocksBinBufferItem,
  type BlocksBufferLoopResult,
  handleConnectionStatusChanges,
  processScanResultWITHOUT_SIDE_EFFECTS,
  writeCacheToFile,
  type BlockInfo,
} from "../../api";

import {
  handleScanLoopResult,
  type ScanLoopInput,
  type ScanLoopYield,
} from "./scanLoop";
import { type WorkItem, makeWorkItem, scanLoop } from "./scanLoop";
import {
  cullTooLargeScanHeight,
  getNonHaltedWallets,
  getPathPrefix,
  openScanSettingsFile,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
  type ScanSettings,
} from "../scanSettings";
import {
  findRange,
  initScanCacheFile,
  makeCacheRangeForHeight,
  mergeRanges,
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
  anchor_range: CacheRange;
  scan_settings: ScanSettings;
};
/**
 * this depends only on ScanSettings.json start_height and wallet caches scanned_ranges
 * side effect: will init wallet cache file if it does not exist
 * side effect: will merge scan ranges + add subaddreses to existing cache files
 * @param scan_settings_path
 */
export async function findWorkToBeDone(
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT,
  pathPrefix?: string,
): Promise<WorkToBeDone | false> {
  const parts = scan_settings_path.split("/");
  const basename = parts.pop()!;
  const dir = parts.join("/");
  const prefix = dir ? `${dir}/` : "";

  const scan_settings = await openScanSettingsFile(scan_settings_path);
  if (!scan_settings) return false;
  const total_start_height = await cullTooLargeScanHeight(
    scan_settings.node_url,
    scan_settings_path,
  );
  const wallets = getNonHaltedWallets(scan_settings);
  if (!wallets.length) return false;
  const potential_anchor_ranges: CacheRange[] = [];
  const wallet_caches: ScanCache[] = [];
  const wallet_configs: WalletConfig[] = [];
  let wallet_without_anchor_at_start_height = false;
  for (const wallet of wallets) {
    const walletSettingsWithKeys = await walletSettingsPlusKeys({
      ...wallet,
      node_url: scan_settings.node_url,
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
    if (!range) {
      wallet_without_anchor_at_start_height = true;
      continue;
    }
    potential_anchor_ranges.push(range);
  }
  //go over all wallets and make sure they have an anchor range at start_height
  if (wallet_without_anchor_at_start_height) {
    const range_at_start = await makeCacheRangeForHeight(
      total_start_height,
      scan_settings.node_url,
    );
    potential_anchor_ranges.push(range_at_start);

    for (const wallet_cache of wallet_caches) {
      wallet_cache.scanned_ranges.push(range_at_start);
      // sort them correctly
      wallet_cache.scanned_ranges = mergeRanges(wallet_cache.scanned_ranges);
    }
  }

  const anchor_range = potential_anchor_ranges.reduce((a, b) =>
    a.end < b.end ? a : b,
  );
  const start_height = anchor_range.end;

  //  connection settings scanned_ranges is reset on every scan
  // (done in setupBlocksBufferGenerator init)
  // ( they cant contain newer ranges then resulting start height after
  // lowest fast forward start height on all wallets )
  return {
    wallet_configs,
    wallet_caches,
    start_height,
    anchor_range,
    scan_settings,
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
      (w) =>
        w.batch.local_uuid === batch.local_uuid &&
        w.primaryAddress === primaryAddress,
    );
    // TODO: better work item creation with a helper
    // should be united tested in conjunction with processScanResultForWorkItem
    if (!alreadyReferenced) {
      const workItem = makeWorkItem(scanCache, batch, primaryAddress, from, to);
      console.log(
        `[reconcileBlocksBufferChanged] workItem: uuid=${workItem.work_uuid.slice()} to=${workItem.to} from=${workItem.from} batchbegin_height=${batch.get_blocks_result_meta.block_infos[0].block_height} batchend_height=${batch.get_blocks_result_meta.block_infos[batch.get_blocks_result_meta.block_infos.length - 1].block_height}`,
      );
      workItemBuffer.push(workItem);
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

/**
 * one round of the select race. takes two primed promises (blocks, scan),
 * races them, returns winner info. the loser stays in flight.
 */
export async function raceStep(
  blocksPromise: Promise<IteratorResult<BlocksBufferLoopResult>>,
  scanPromise: Promise<IteratorResult<ScanLoopYield, void>>,
): Promise<{
  src: "blocks" | "scan";
  value:
    | IteratorResult<BlocksBufferLoopResult>
    | IteratorResult<ScanLoopYield, void>;
  done: boolean;
}> {
  const winner = await Promise.race([
    blocksPromise.then((v) => ({ src: "blocks" as const, value: v })),
    scanPromise.then((v) => ({ src: "scan" as const, value: v })),
  ]);
  const value = winner.value;
  const done = !!winner.value.done;
  return { src: winner.src, value, done };
}

/**
 * handle a yield from the blocks buffer fetch loop.
 */
export async function handleBlocksYield(
  value: BlocksBufferLoopResult,
  scanSettingsPath?: string,
): Promise<{
  isBlocksBufferChanged: boolean;
}> {
  if (value === "blocks_buffer_changed") {
    return { isBlocksBufferChanged: true };
  }
  await handleConnectionStatusChanges(value, scanSettingsPath);
  return { isBlocksBufferChanged: false };
}

/**
 * process a scan result for a completed work item.
 * updates the cache, writes to disk, marks work item done, reconciles.
 */
export async function processScanResultForWorkItem(
  value: ScanLoopYield,
  workBuffer: import("./scanLoop").WorkItem[],
  blocksBuffer: GetBlocksBinBufferItem[],
  pathPrefix: string,
  secret_spend_key?: string,
): Promise<void> {
  if (value.type !== "Ready" || !value.result || !value.work_uuid) return;

  const item = workBuffer.find((w) => w.work_uuid === value.work_uuid);
  //console.log(`[processScanResultForWorkItem] item=${JSON.stringify(item)}`);

  if (!item || item.done) return;

  const firstBlock = item.batch.get_blocks_result_meta.block_infos[item.from];
  //console.log(`
  //  [processScanResultForWorkItem] block_infos=${JSON.stringify(item.batch.get_blocks_result_meta.block_infos)} block_infos.length=${item.batch.get_blocks_result_meta.block_infos.length} firstBlock=${firstBlock} `);
  console.log(
    `[processScanResultForWorkItem] block_infos.length=${item.batch.get_blocks_result_meta.block_infos.length} from=${item.from} to=${item.to}`,
  );
  const lastBlock = item.batch.get_blocks_result_meta.block_infos[item.to];
  const cache = item.scanCache;

  await processScanResultWITHOUT_SIDE_EFFECTS({
    from_height: firstBlock.block_height,
    to_height: lastBlock.block_height,
    result: value.result,
    scanCache: cache,
    secret_spend_key,
  });

  await writeCacheToFile(cache, pathPrefix);
  handleScanLoopResult(value, workBuffer);
  reconcileWorkItemDone(blocksBuffer, workBuffer);
  //because cache is tied to the workitems by reference,
  // the following workitems will have the most recent cache
  //TODO: if we do cpu workers we need to be sure to wait with the processing at the top of this functon
  // until all workitems for this wallet before it (to the left of it) are done
  //  the cpu worker loop generator will have to ensure the order of this
  // currently as a sideeffect of the work scheduling function on fetch result aka blocks buffer changed,
  // this is already implicitly handled
}
export type CoordinatorEvent =
  | { type: "blocks_buffer_changed" }
  | { type: "connection_status"; status: any }
  | {
      type: "scan_ready";
      address: string;
      result: ScanLoopYield;
      newCache: ScanCache;
      changed_outputs: { output: any; change_reason: string }[];
    }
  | { type: "all_idle" }
  | { type: "error"; error: Error };

function logBufStatus(
  blocksBuffer: GetBlocksBinBufferItem[],
  workBuffer: WorkItem[],
  scanPromises: Map<string, any>,
  label: string,
) {
  const bb = blocksBuffer.map(
    (b) =>
      b.get_blocks_result_meta.block_infos[0]?.block_height +
      "-" +
      b.get_blocks_result_meta.block_infos.at(-1)?.block_height,
  );
  const wb = workBuffer.map(
    (w) =>
      (w.done ? "D" : "") +
      w.primaryAddress.slice(0, 6) +
      "@" +
      w.batch.get_blocks_result_meta.block_infos[w.from]?.block_height +
      "-" +
      w.batch.get_blocks_result_meta.block_infos[w.to]?.block_height,
  );
  console.log(
    `[buf] ${label} blocks=[${bb.join(",")}] work=[${wb.join(",")}] scans=${scanPromises.size}`,
  );
}
export type ProcessResultPromise = Promise<ScanLoopYield>;
export type ProcessResultBuffer = ProcessResultPromise[];
export type WalletSyncInfo = {
  wallet_config: WalletConfig;
  cache: ScanCache;
  result_promises: ProcessResultBuffer;
};
/**
 * coordinator main: async generator that drives the full scan cycle.
 * takes only scanSettingsPath, derives everything else internally.
 * yields events for some of the underlying generator events
 * look at CoordinatorEvent
 */
export async function* coordinatorMain(
  scanSettingsPath?: string,
  pathPrefix?: string,
): AsyncGenerator<CoordinatorEvent> {
  const w = await findWorkToBeDone(scanSettingsPath, pathPrefix);
  if (!w) {
    yield {
      type: "error",
      error: new Error("findWorkToBeDone returned false"),
    };
    return;
  }

  const { generator: blocksGen, blocksBuffer } =
    await setupBlocksBufferGenerator({
      nodeUrl: w.scan_settings.node_url,
      startHeight: w.start_height,
      anchor_range: w.anchor_range,
      scanSettingsPath,
    });

  const workBuffer: WorkItem[] = [];
  const scanGens = new Map<
    string,
    AsyncGenerator<ScanLoopYield, void, ScanLoopInput>
  >();
  const walletCaches = new Map<string, ScanCache>();

  for (let i = 0; i < w.wallet_configs.length; i++) {
    const wc = w.wallet_configs[i];
    walletCaches.set(wc.primary_address, w.wallet_caches[i]);
    scanGens.set(
      wc.primary_address,
      scanLoop({
        primary_address: wc.primary_address,
        secret_view_key: wc.secret_view_key,
        secret_spend_key: wc.secret_spend_key,
        subaddress_index: wc.subaddress_index,
      }),
    );
  }

  // prime all scan generators
  // ( technically no need to do this as loop + scan generator + workbuffer structure mean it will happen automatically)
  for (const [, gen] of scanGens) {
    await gen.next();
  }

  let blocksPromise = blocksGen.next();
  const scanPromises = new Map<
    string,
    Promise<IteratorResult<ScanLoopYield, void>>
  >();

  while (true) {
    const races: Promise<{
      src: "blocks" | "scan";
      addr?: string;
      value: any;
    }>[] = [blocksPromise.then((v) => ({ src: "blocks" as const, value: v }))];
    for (const [addr, p] of scanPromises) {
      races.push(p.then((v) => ({ src: "scan" as const, addr, value: v })));
    }

    const winner = await Promise.race(races);

    if (winner.value.done) {
      if (winner.src === "blocks") break;
      scanPromises.delete(winner.addr!);
      continue;
    }

    if (winner.src === "blocks") {
      const result = winner.value.value as BlocksBufferLoopResult;
      const { isBlocksBufferChanged } = await handleBlocksYield(
        result,
        scanSettingsPath,
      );
      if (isBlocksBufferChanged) {
        for (const wc of w.wallet_configs) {
          const cache = walletCaches.get(wc.primary_address);
          if (!cache) continue;
          reconcileBlocksBufferChanged(
            blocksBuffer,
            workBuffer,
            cache,
            wc.primary_address,
            0,
          );
        }
        // start scan promises for wallets that now have work
        for (const wc of w.wallet_configs) {
          const addr = wc.primary_address;
          if (scanPromises.has(addr)) continue;
          const gen = scanGens.get(addr);
          console.log("scanGens.get(addr)", gen);
          if (!gen) continue;
          const item = workBuffer.find(
            (x) => !x.done && x.primaryAddress === addr,
          );
          if (item) scanPromises.set(addr, gen.next(item));
        }
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "after_blocks");
        yield { type: "blocks_buffer_changed" };
      } else {
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "fetch_conn");
        yield { type: "connection_status", status: result };
      }
      blocksPromise = blocksGen.next();
    } else {
      const addr = winner.addr!;
      const gen = scanGens.get(addr)!;
      const value = winner.value.value as ScanLoopYield;

      if (value.type === "InProgress") {
        scanPromises.set(addr, gen.next());
      } else if (value.type === "Ready") {
        const wc = w.wallet_configs.find((x) => x.primary_address === addr);
        await processScanResultForWorkItem(
          value,
          workBuffer,
          blocksBuffer,
          getPathPrefix(scanSettingsPath, pathPrefix),
          wc?.secret_spend_key,
        );
        const nextItem = workBuffer.find(
          (x) => !x.done && x.primaryAddress === addr,
        );
        if (nextItem) {
          scanPromises.set(addr, gen.next(nextItem));
        } else {
          scanPromises.delete(addr);
        }
        const updatedCache = walletCaches.get(addr);
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "after_scan");
        yield {
          type: "scan_ready",
          address: addr,
          result: value,
          newCache: updatedCache ?? ({} as ScanCache),
          changed_outputs: [],
        };

        // signal idle when no scans active and nothing buffered
        if (scanPromises.size === 0 && blocksBuffer.length === 0) {
          yield { type: "all_idle" };
        }
      }
    }
  }
}
export function workToBeDoneForThisWalletAndBatch(
  scan_cache: ScanCache,
  batch_meta_block_infos: BlockInfo[],
) {
  //TODO
  //throw error if there is no work to be done for all wallets
  // so findwork can be called again
}
