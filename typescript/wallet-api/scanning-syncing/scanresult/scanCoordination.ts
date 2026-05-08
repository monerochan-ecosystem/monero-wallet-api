import {
  setupBlocksBufferGenerator,
  ViewPair,
  type GetBlocksBinBufferItem,
  type BlocksBufferLoopResult,
  handleConnectionStatusChanges,
  processScanResultWITHOUT_SIDE_EFFECTS,
  writeCacheToFile,
  type BlocksBufferIteratorResult,
  type ProcessScanResult,
  sleep,
  type BlockInfo,
  findTipIndex,
} from "../../api";

import {
  markWorkItemAsDone,
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
  findRangeThrows,
  initScanCacheFile,
  makeCacheRangeForHeight,
  mergeRanges,
  type CacheRange,
  type ScanCache,
} from "./scanCache";
import { sendToCpuWorker } from "../worker-mains/cpubound-main";
export type WalletConfig = {
  primary_address: string;
  secret_view_key: string;
  secret_spend_key?: string;
  subaddress_index: number;
};
export type WalletConfigPlusCache = {
  primary_address: string;
  secret_view_key: string;
  secret_spend_key?: string;
  subaddress_index: number;
  cache: ScanCache;
};
export type WorkToBeDone = {
  start_height: number;
  wallet_configs: WalletConfigPlusCache[];
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
  const wallet_configs: WalletConfigPlusCache[] = [];
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
      cache: walletCache,
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
      // only add the range to wallets that don't already have one
      if (!findRange(wallet_cache.scanned_ranges, total_start_height)) {
        wallet_cache.scanned_ranges.push(range_at_start);
        wallet_cache.scanned_ranges = mergeRanges(wallet_cache.scanned_ranges);
      }
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
    start_height,
    anchor_range,
    scan_settings,
  };
}
export function workToBeDoneForBatch(
  cache: ScanCache,
  batch_meta_infos: BlockInfo[],
): "skip" | { from: number } {
  const begin_height = batch_meta_infos[0].block_height;
  const end_height = batch_meta_infos[batch_meta_infos.length - 1].block_height;
  console.log("[workToBeDoneForBatch]", begin_height, end_height);
  const foundRange = findRange(cache.scanned_ranges, begin_height);
  console.log("[workToBeDoneForBatch] foundRange", foundRange);
  if (foundRange) {
    const fullycovered = cache.scanned_ranges.find(
      (r) => r.start <= begin_height && r.end >= end_height,
    );
    if (fullycovered) {
      // THIS IS OLD WORK OR CAT REORG OR NORMAL REORG
      const tip = fullycovered.block_hashes.at(0);
      if (!tip)
        throw new Error(
          "[workToBeDoneForBatch] tip not found, malformed range that covers the work to be done for this batch",
        );
      if (findTipIndex(batch_meta_infos, tip) === "reorg_found") {
        // THIS MIGHT BE A CAT REORG or old range, or a normal reorg
        const candidate = fullycovered.block_hashes.at(1);
        const anchor = fullycovered.block_hashes.at(-1);
        if (!candidate || !anchor)
          throw new Error(
            "[workToBeDoneForBatch] could not find candidate or anchor, malformed range that covers the work to be done for this batch",
          );
        const candidateIndex = findTipIndex(batch_meta_infos, candidate);

        const anchorIndex = findTipIndex(batch_meta_infos, anchor);
        // CAT REORG or SKIP OLD RANGE
        if (candidateIndex === "reorg_found" && anchorIndex === "reorg_found") {
          console.log("[workToBeDoneForBatch] old range");
          // we have to rely on the scan level cat reorg detection.
          // no way to distinguish really old work prior to the anchors from a cat reorg at this point

          return "skip"; // this could also be a cat reorg, but we can't distinguish here
        }
        console.log("[workToBeDoneForBatch] reorg found");
        return { from: 0 }; // THIS IS A NORMAL REORG, redo work
      } else {
        return "skip"; // NORMAL CASE, found tip in fully covered range
      }
    } else {
      // NORMAL CASE directly in front of tip
      // not fully covered. normal case of scheduling directly in front of the tip
      // tip might be in a bit, but the extra complexity is not worth the small performance difference
      // findTip should solve this in the processWorkItem step
      return { from: 0 }; // NORMAL case of scheduling directly in front of the tip
    }
  } else {
    // NORMAL case of scheduling work ahead of the already processed ranges, with gap so we can do CPU work in parallel
    // didnt see this range might be ahead and will be processed in order after the prioor badges are processed
    return { from: 0 };
  }
}

/**
 * called when the blocks buffer generator yields "blocks_buffer_changed".
 * adds new work items for blocks buffer items not yet referenced.
 * per wallet
 */
export function makeWorkItemsFromBlocksBuffer(
  blocksBuffer: GetBlocksBinBufferItem[],
  workItemBuffer: WorkItem[],
  walletConfig: WalletConfigPlusCache,
  from?: number,
  to?: number,
): void {
  // add work items for blocks buffer items not yet referenced
  for (const batch of blocksBuffer) {
    const alreadyReferenced = workItemBuffer.some(
      (w) =>
        w.batch.local_uuid === batch.local_uuid &&
        w.walletConfig.primary_address === walletConfig.primary_address,
    );
    if (!alreadyReferenced) {
      // const begin_height =
      //   batch.get_blocks_result_meta.block_infos[0].block_height;
      // const end_height =
      //   batch.get_blocks_result_meta.block_infos[
      //     batch.get_blocks_result_meta.block_infos.length - 1
      //   ].block_height;
      // console.log(walletConfig.cache.scanned_ranges);
      // console.log(begin_height);

      // // skip batches fully covered by an existing scanned range
      // if (
      //   walletConfig.cache.scanned_ranges.some(
      //     (r) => r.start <= begin_height && r.end >= end_height,
      //   )
      // ) {
      //   throw new Error(
      //     "skip" +
      //       begin_height +
      //       " end_height" +
      //       end_height +
      //       " " +
      //       walletConfig.primary_address.slice(0, 6),
      //   );
      //   continue;
      // }
      const workToBeDone = workToBeDoneForBatch(
        walletConfig.cache,
        batch.get_blocks_result_meta.block_infos,
      );
      if (workToBeDone === "skip") {
        continue;
      }
      const workItem = makeWorkItem(walletConfig, batch, from, to);
      console.log(
        `[reconcileBlocksBufferChanged] workItem: uuid=${workItem.work_uuid.slice()} to=${workItem.to} from=${workItem.from} batchbegin_height=${batch.get_blocks_result_meta.block_infos[0].block_height} batchend_height=${batch.get_blocks_result_meta.block_infos[batch.get_blocks_result_meta.block_infos.length - 1].block_height}`,
      );
      workItemBuffer.push(workItem);
    }
  }
}
export function makeWorkItemsForAllWallets(
  wallet_configs: WalletConfigPlusCache[],
  blocksBuffer: GetBlocksBinBufferItem[],
  workBuffer: WorkItem[],
) {
  for (const wc of wallet_configs) {
    makeWorkItemsFromBlocksBuffer(blocksBuffer, workBuffer, wc);
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
  // console.log(
  //   `[reconcileWorkItemDone] workItemBuffer.length=${workItemBuffer.length} , blocksBuffer.length=${blocksBuffer.length}`,
  // );
  while (
    workItemBuffer.length > 0 &&
    workItemBuffer[0].status === "process_result_done"
  ) {
    const removed = workItemBuffer.shift()!;
    const stillReferenced = workItemBuffer.some(
      (w) => w.batch.local_uuid === removed.batch.local_uuid,
    );
    // console.log(
    //   `[reconcileWorkItemDone] workItem: ${removed.work_uuid.slice()} removed. stillReferenced=${stillReferenced}`,
    // );
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
  if ("local_uuid" in value && typeof value.local_uuid === "string") {
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
  workBuffer: WorkItem[],
  blocksBuffer: GetBlocksBinBufferItem[],
  pathPrefix: string,
  secret_spend_key?: string,
): Promise<void> {
  if (value.type !== "Ready" || !value.result || !value.work_uuid) return;

  const item = await markWorkItemAsDone(value, workBuffer);
  //console.log(`[processScanResultForWorkItem] item=${JSON.stringify(item)}`);

  if (!item || item.status !== "scanwork_done")
    throw new Error(
      "[processScanResultForWorkItem] item not found or not scanwork not done. item_status=" +
        item?.status,
    );

  const firstBlock = item.batch.get_blocks_result_meta.block_infos[item.from];
  //console.log(`
  //  [processScanResultForWorkItem] block_infos=${JSON.stringify(item.batch.get_blocks_result_meta.block_infos)} block_infos.length=${item.batch.get_blocks_result_meta.block_infos.length} firstBlock=${firstBlock} `);
  console.log(
    `[processScanResultForWorkItem] block_infos.length=${item.batch.get_blocks_result_meta.block_infos.length} from=${item.from} to=${item.to}`,
  );
  const lastBlock = item.batch.get_blocks_result_meta.block_infos[item.to];
  const cache = item.walletConfig.cache;

  await processScanResultWITHOUT_SIDE_EFFECTS({
    from_height: firstBlock.block_height,
    to_height: lastBlock.block_height,
    result: value.result,
    scanCache: cache,
    secret_spend_key,
  });

  await writeCacheToFile(cache, pathPrefix);
  item.status = "process_result_done";
  reconcileWorkItemDone(blocksBuffer, workBuffer);
  //because cache is tied to the workitems by reference,
  // the following workitems will have the most recent cache
  //TODO: if we do cpu workers we need to be sure to wait with the processing at the top of this functon
  // until all workitems for this wallet before it (to the left of it) are done
  //  the cpu worker loop generator will have to ensure the order of this
  // currently as a sideeffect of the work scheduling function on fetch result aka blocks buffer changed,
  // this is already implicitly handled
}
/**
 * process a scan result for a completed work item.
 * updates the cache, writes to disk, marks work item done, reconciles blockbuffer with this.
 */
export async function processWorkItem(
  item: WorkItem,
  workBuffer: WorkItem[],
  blocksBuffer: GetBlocksBinBufferItem[],
  pathPrefix: string,
  secret_spend_key?: string,
): Promise<ProcessScanResult> {
  if (item.status !== "scanwork_done")
    throw new Error(
      "[processWorkItem] item not found or not scanwork not done. item_status=" +
        item?.status,
    );

  const firstBlock = item.batch.get_blocks_result_meta.block_infos[item.from];

  // console.log(
  //   `[processWorkItem] block_infos.length=${item.batch.get_blocks_result_meta.block_infos.length} from=${item.from} to=${item.to}`,
  // );
  const lastBlock = item.batch.get_blocks_result_meta.block_infos[item.to];
  // console.log(
  //   "[processWorkItem] ",
  //   item.walletConfig.primary_address.slice(0, 6),
  //   "@",
  //   firstBlock.block_height,
  //   "-",
  //   lastBlock.block_height,
  // );

  const cache = item.walletConfig.cache;
  let res;
  try {
    res = await processScanResultWITHOUT_SIDE_EFFECTS({
      from_height: firstBlock.block_height,
      to_height: lastBlock.block_height,
      result: item.result,
      scanCache: cache,
      secret_spend_key,
    });
    // console.log("[processWorkItem] res=", res);
  } catch (error) {
    console.error("[processWorkItem] error=", error);
    throw error;
  }

  await writeCacheToFile(cache, pathPrefix);
  item.status = "process_result_done";
  //console.log(`[processWorkItem] process_result_done item=${JSON.stringify(item)}`);
  // remove from blocksbuffer if no more work items reference it
  reconcileWorkItemDone(blocksBuffer, workBuffer);
  //because cache is tied to the workitems by reference,
  // the following workitems will have the most recent cache
  // if we do cpu workers we need to be sure to wait with the processing at the top of this functon
  // until all workitems for this wallet before it (to the left of it) are done
  //  the cpu worker loop generator will have to ensure the order of this
  // currently as a sideeffect of the work scheduling function on fetch result aka blocks buffer changed,
  // this is already implicitly handled
  return res as ProcessScanResult;
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
  ports: PortStatus[] | Map<string, any>,
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
      w.status +
      w.walletConfig.primary_address.slice(0, 6) +
      "@" +
      w.batch.get_blocks_result_meta.block_infos[w.from]?.block_height +
      "-" +
      w.batch.get_blocks_result_meta.block_infos[w.to]?.block_height,
  );

  console.log(
    `[buf] ${label} blocks=[${bb.join(",")}] work=[${wb.join(",")}] `,
  );
}
/**
 * coordinator main: async generator that drives the full scan cycle.
 * takes only scanSettingsPath, derives everything else internally.
 * yields events for some of the underlying generator events,
 * look at CoordinatorEvent, processing not decoupled from cpu bound scan work,
 * as this single threaded, there is no point
 */
export async function* coordinatorMain(
  scanSettingsPath?: string,
  pathPrefix?: string,
): AsyncGenerator<CoordinatorEvent> {
  const ctx = await setupCoordinator(scanSettingsPath, pathPrefix);
  if (!ctx)
    throw new Error("[coordinatorMain] findWorkToBeDone returned false");
  const work_to_be_done = ctx.work_to_be_done;
  const blocksBuffer = ctx.blocksBuffer;
  const workBuffer = ctx.workBuffer;
  const blocksGenerator = ctx.blocksGenerator;
  let blocksPromise = blocksGenerator.next();

  const scanGens = new Map<
    string,
    AsyncGenerator<ScanLoopYield, void, ScanLoopInput>
  >();

  const scanPromises = new Map<
    string,
    Promise<IteratorResult<ScanLoopYield, void>>
  >();

  for (const wc of work_to_be_done.wallet_configs) {
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

    console.log(
      "[coordinatorMain] winner=" +
        winner.src +
        " addr=" +
        String(winner.addr ?? "").slice(0, 8),
    );

    if (winner.src === "blocks") {
      const result = winner.value.value as BlocksBufferLoopResult;
      const { isBlocksBufferChanged } = await handleBlocksYield(
        result,
        scanSettingsPath,
      );
      if (isBlocksBufferChanged) {
        makeWorkItemsForAllWallets(
          work_to_be_done.wallet_configs,
          blocksBuffer,
          workBuffer,
        );
        // start scan promises for wallets that now have work
        for (const wc of work_to_be_done.wallet_configs) {
          const addr = wc.primary_address;
          if (scanPromises.has(addr)) continue;
          const gen = scanGens.get(addr);
          console.log("scanGens.get(addr)", gen);
          if (!gen) continue;
          const item = workBuffer.find(
            (x) =>
              x.status === "fresh" && x.walletConfig.primary_address === addr,
          );

          if (item) {
            item.status = "scanwork_in_progress";
            scanPromises.set(addr, gen.next(item));
          }
        }
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "after_blocks");
        yield { type: "blocks_buffer_changed" };
      } else {
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "fetch_conn");
        yield { type: "connection_status", status: result };
      }
      blocksPromise = blocksGenerator.next();
    } else {
      const addr = winner.addr!;
      const gen = scanGens.get(addr)!;
      const value = winner.value.value as ScanLoopYield;

      if (value.type === "InProgress") {
        scanPromises.set(addr, gen.next());
      } else if (value.type === "Ready") {
        const wc = work_to_be_done.wallet_configs.find(
          (x) => x.primary_address === addr,
        );
        if (!wc)
          throw new Error(
            "[coordinatorMain] wallet config not found on process result",
          );
        await processScanResultForWorkItem(
          value,
          workBuffer,
          blocksBuffer,
          getPathPrefix(scanSettingsPath, pathPrefix),
          wc?.secret_spend_key,
        );
        const nextItem = workBuffer.find(
          (x) =>
            x.status !== "process_result_done" &&
            x.walletConfig.primary_address === addr,
        );
        if (nextItem) {
          scanPromises.set(addr, gen.next(nextItem));
        } else {
          scanPromises.delete(addr);
        }
        logBufStatus(blocksBuffer, workBuffer, scanPromises, "after_scan");
        yield {
          type: "scan_ready",
          address: addr,
          result: value,
          newCache: wc.cache,
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
export async function setupCoordinator(
  scanSettingsPath?: string,
  pathPrefix?: string,
) {
  const work_to_be_done = await findWorkToBeDone(scanSettingsPath, pathPrefix);
  if (!work_to_be_done) return false;
  const { generator: blocksGenerator, blocksBuffer } =
    await setupBlocksBufferGenerator({
      nodeUrl: work_to_be_done.scan_settings.node_url,
      startHeight: work_to_be_done.start_height,
      anchor_range: work_to_be_done.anchor_range,
      scanSettingsPath,
    });

  const workBuffer: WorkItem[] = [];

  return {
    blocksGenerator,
    workBuffer,
    blocksBuffer,
    work_to_be_done,
  };
}
export type PortStatus = {
  port: MessagePort;
  promise: Promise<ScanLoopYield> | null;
};
export type BlocksBufferRacer = {
  src: "blocks";
  value: BlocksBufferIteratorResult;
};
export type ScanLoopRacer = ScanLoopYield;
export type Racers = BlocksBufferRacer | ScanLoopRacer;
/**
 * coordinator main (multithreaded): dispatches scan work to CPU workers
 * via MessagePorts, processes results in order per wallet.
 * falls back to single-threaded coordinator if no cpuPorts provided.
 */
export async function* coordinatorMainMultithreaded(
  scanSettingsPath?: string,
  pathPrefix?: string,
  cpuPorts?: MessagePort[],
): AsyncGenerator<CoordinatorEvent> {
  if (!cpuPorts || cpuPorts.length === 0) {
    // throw new Error(
    //   "[coordinatorMain Multithreaded] cpuPorts empty, there must be at least cpu worker",
    // );
    console.log("[coordinatorMainMultithreaded] fallback to single-threaded");
    yield* coordinatorMain(scanSettingsPath, pathPrefix);
    return;
  }
  const ctx = await setupCoordinator(scanSettingsPath, pathPrefix);
  if (!ctx)
    throw new Error(
      "[coordinatorMain Multithreaded] findWorkToBeDone returned false",
    );
  const work_to_be_done = ctx.work_to_be_done;
  const blocksBuffer = ctx.blocksBuffer;
  const workBuffer = ctx.workBuffer;

  const blocksGenerator = ctx.blocksGenerator;
  let blocksPromise = blocksGenerator.next();

  const freePorts: PortStatus[] = [];
  for (const port of cpuPorts) {
    const ps: PortStatus = {
      port,
      promise: null,
    };

    freePorts.push(ps);
  }
  let race_count = 0;
  while (true) {
    race_count++;
    console.log("[coordinatorMainMultithreaded] race_count", race_count);
    await scheduleWorkOnCpuPorts(freePorts, workBuffer);
    const scan_promises = freePorts
      .filter((ps) => ps.promise)
      .map((ps) => ps.promise!);

    const races: Promise<Racers>[] = [
      ...scan_promises,
      blocksPromise.then((v) => ({
        src: "blocks" as const,
        value: v as BlocksBufferIteratorResult,
      })),
    ];
    console.log("[coordinatorMainMultithreaded] races", races);
    const winner = await Promise.race(races);
    //console.log("[coordinatorMainMultithreaded] cpu ports status", freePorts);
    if ("src" in winner && winner.src === "blocks") {
      const result = winner.value.value;
      const { isBlocksBufferChanged } = await handleBlocksYield(
        result,
        scanSettingsPath,
      );
      if (isBlocksBufferChanged) {
        //todo pass new blocksbuffer items after simplified blocksbuffer fetch loop
        makeWorkItemsForAllWallets(
          work_to_be_done.wallet_configs,
          blocksBuffer,
          workBuffer,
        );
        yield { type: "blocks_buffer_changed" };
      } else {
        yield { type: "connection_status", status: result };
      }
      blocksPromise = blocksGenerator.next();
    }
    logBufStatus(blocksBuffer, workBuffer, freePorts, "after_winner");

    for (const wallet of work_to_be_done.wallet_configs) {
      const workitems_for_wallet = workBuffer.filter(
        (x) => x.walletConfig.primary_address === wallet.primary_address,
      );
      const processable: WorkItem[] = [];
      for (const w of workitems_for_wallet) {
        if (w.status === "scanwork_done") {
          processable.push(w);
        } else if (w.status === "process_result_done") {
          continue;
        } else {
          break;
        }
      }
      for (const to_be_processed of processable) {
        const res = await processWorkItem(
          to_be_processed,
          workBuffer,
          blocksBuffer,
          getPathPrefix(scanSettingsPath, pathPrefix),
          wallet.secret_spend_key,
        );
        //  console.log("[coordinatorMainMultithreaded] processWorkItem result", res);
        yield {
          type: "scan_ready",
          address: wallet.primary_address,
          result: {
            type: "Ready",
            work_uuid: to_be_processed.work_uuid,
            result: to_be_processed.result,
          },
          newCache: wallet.cache,
          changed_outputs: res.changed_outputs,
        };
      }
    }
  }
}
export async function scheduleWorkOnCpuPorts(
  ports: PortStatus[],
  work_buffer: WorkItem[],
) {
  for (const port_status of ports) {
    if (port_status.promise === null) {
      const item = work_buffer.find((x) => x.status === "fresh");
      if (!item) return;
      let resolve_port: (value: ScanLoopYield) => void;
      let resolve_workstart: () => void;
      const workstart_promsie = new Promise<void>((resolve) => {
        resolve_workstart = resolve;
      });
      const onmessage = (event: MessageEvent) => {
        const msg = event.data as
          | ScanLoopYield
          | { type: "WORKSTART"; work_uuid: string };
        // handle the result here:
        console.log("[scheduleWorkOnCpuPorts] onmessage result", msg);
        if (msg.work_uuid !== item.work_uuid) {
          console.log(
            "[scheduleWorkOnCpuPorts] wrong work_uuid in msg msg.work_uuid=",
            msg.work_uuid,
            "item.work_uuid=",
            item.work_uuid,
          );
          throw new Error("[scheduleWorkOnCpuPorts] wrong work_uuid in msg");
        }
        if (msg.type === "WORKSTART") {
          resolve_workstart();
          return;
        }
        item.result = msg.result;
        item.status = "scanwork_done";
        port_status.promise = null;
        resolve_port(msg);
      };
      port_status.port.onmessage = onmessage;
      item.status = "scanwork_in_progress";
      console.log(
        "[scheduleWorkOnCpuPorts] scheduling work item",
        item.work_uuid,
      );
      port_status.promise = new Promise<ScanLoopYield>((resolve) => {
        resolve_port = resolve;
      });
      const strippedItem = {
        ...item,
        walletConfig: {
          primary_address: item.walletConfig.primary_address,
          secret_view_key: item.walletConfig.secret_view_key,
          //secret_spend_key: item.walletConfig.secret_spend_key, only needed for processResult to make ownkeyimages
          subaddress_index: item.walletConfig.subaddress_index,
        },
      };
      let workstart_promise: Promise<void> = workstart_promsie;
      for (let attempt = 1; ; attempt++) {
        sendToCpuWorker(port_status.port, strippedItem as ScanLoopInput);
        try {
          await Promise.race([
            workstart_promise,
            sleep(1000).then(() => Promise.reject(new Error("timeout"))),
          ]);
          break;
        } catch {
          console.log(
            "[scheduleWorkOnCpuPorts] resend attempt",
            attempt,
            item.work_uuid,
          );
          workstart_promise = new Promise<void>((resolve) => {
            resolve_workstart = resolve;
          });
        }
      }
    }
  }
}
