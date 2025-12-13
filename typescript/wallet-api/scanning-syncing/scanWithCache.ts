import type { Output, ScanResult, ScanResultCallback } from "../api";
import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
import { computeKeyImage, type KeyImage } from "./computeKeyImage";
/**
 * Scans blockchain from `start_height` using the provided processor and using the provided initialCachePath file path,
 *  invoking callback cacheChanged() for results and cache changes
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param start_height - Starting block height for the scan
 * @param initialCachePath: string - Optional initial scan cache file path. (will get created if it does not exist)
 * @param cacheChanged - params: newCache, added, ownspend, reorged {@link CacheChangedCallback} invoked when cache changes
 * @param stopSync - Optional abort signal to stop scanning
 * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 * @param stop_height - Optional ending block height (null = keep scanning)
 */
export async function scanWithCacheFile<
  T extends WasmProcessor &
    HasScanMethod &
    HasScanWithCacheMethod &
    HasPrimaryAddress
>(
  processor: T,
  start_height: number,
  initialCachePath: string,
  cacheChanged: CacheChangedCallback = (...args) => console.log(args),
  stopSync?: AbortSignal,
  spend_private_key?: string, // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
  stop_height: number | null = null
) {
  const jsonString = await Bun.file(initialCachePath)
    .text()
    .catch(() => undefined);
  const initialScanCache = jsonString
    ? (JSON.parse(jsonString) as ScanCache)
    : undefined;
  const cacheCallback: CacheChangedCallback = async (...args) => {
    const [newCache] = args;
    await Bun.write(initialCachePath, JSON.stringify(newCache, null, 2));
    await cacheChanged(...args);
  };
  await processor.scanWithCache(
    start_height,
    initialScanCache,
    cacheCallback,
    stopSync,
    spend_private_key,
    stop_height
  );
}
export interface HasScanWithCacheMethod {
  scanWithCache: <T extends WasmProcessor & HasScanMethod & HasPrimaryAddress>(
    start_height: number,
    initialCache?: ScanCache,
    cacheChanged?: CacheChangedCallback,
    stopSync?: AbortSignal,
    spend_private_key?: string,
    stop_height?: number | null
  ) => Promise<void>;
}
export interface HasScanMethod {
  scan: (
    start_height: number,
    callback: ScanResultCallback,
    stopSync?: AbortSignal,
    stop_height?: number | null
  ) => Promise<void>;
}

export interface HasPrimaryAddress {
  primary_address: string;
}

export type CacheRange = {
  start: number;
  end: number;
};

export type GlobalOutputId = string; // output.index_on_blockchain.toString()
export type OutputsCache = Record<GlobalOutputId, Output>; // { "123": Output, "456": Output } keyed by index_on_blockchain.toString()
export type OwnKeyImages = Record<KeyImage, GlobalOutputId>;
export type ScanCache = {
  outputs: OutputsCache;
  own_key_images: OwnKeyImages;
  scanned_ranges: CacheRange[]; // list of block height ranges that have been scanned [0].start, [length-1].end <-- last scanned height
  primary_address: string;
};
export type CacheChangedCallbackSync<R = void> = (
  newCache: ScanCache,
  added: GlobalOutputId[],
  ownspend: GlobalOutputId[]
  // reorged: GlobalOutputId[] //  outputs that were reorged
) => R;

export type CacheChangedCallbackAsync = CacheChangedCallbackSync<Promise<void>>;
/**
 * Callback invoked when the scan cache changes.
 *
 * @param newCache - The updated scan cache
 * @param added - Array of `GlobalOutputId`s for outputs that were newly added in the scan.
 * @param ownspend - Array of `GlobalOutputId`s for outputs we spent ourselves.
 *                   Use these to construct wallet transaction history.
 * @param reorged - Array of `GlobalOutputId`s for outputs affected by a blockchain reorg.
 *
 * @remarks
 *  Use these indices to access corresponding outputs in `newCache`:
 * - `added` indices correspond to outputs in `ScanChange.outputs` from both caches
 * - `ownspend` and `reorged` arrays may be empty on some calls
 *
 * - `scanned_ranges` is expected to change on every invocation
 */
export type CacheChangedCallback =
  | CacheChangedCallbackSync
  | CacheChangedCallbackAsync; // accept async callbacks

/**
 * Scans blockchain from `start_height` using the provided processor and using the provided initialCache,
 *  invoking callback cacheChanged() for results and cache changes
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param start_height - Starting block height for the scan
 * @param initialCache - Optional initial scan cache
 * @param cacheChanged - params: newCache, added, ownspend, reorged {@link CacheChangedCallback} invoked when cache changes
 * @param stopSync - Optional abort signal to stop scanning
 * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 * @param stop_height - Optional ending block height (null = keep scanning)
 */
export async function scanWithCache<
  T extends WasmProcessor & HasScanMethod & HasPrimaryAddress
>(
  processor: T,
  start_height: number,
  initialCache?: ScanCache,
  cacheChanged: CacheChangedCallback = (...args) => console.log(args),
  stopSync?: AbortSignal,
  spend_private_key?: string, // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
  stop_height: number | null = null
) {
  let cache: ScanCache = {
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: processor.primary_address,
  };
  if (initialCache) cache = initialCache;
  let current_height = start_height;
  // merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  const fastForward = findRangeEnd(cache.scanned_ranges, current_height);
  if (fastForward) current_height = fastForward;

  await scanLoop();
  async function scanLoop() {
    while (true) {
      try {
        await processor.scan(
          current_height,
          async (result) => {
            if ("new_height" in result) {
              // Process outputs without writing to database
              let added = [];
              let ownspend = [];
              for (const output of result.outputs) {
                // 1. add to outputs cache 2. add to added array for cacheChanged callback
                const globalId = output.index_on_blockchain.toString();
                cache.outputs[globalId] = output;
                added.push(output.index_on_blockchain.toString());

                // 3. if this is not view only, add the key image to the cache, to find transactions spent by this wallet
                if (spend_private_key) {
                  let keyImage = await computeKeyImage(
                    output,
                    spend_private_key
                  );
                  if (keyImage) {
                    cache.own_key_images[keyImage] = globalId;
                  }
                }
              }

              for (const onchainKeyImage of result.all_key_images) {
                if (onchainKeyImage.key_image_hex in cache.own_key_images) {
                  // this is one of ours
                  const globalId =
                    cache.own_key_images[onchainKeyImage.key_image_hex];
                  // add the information where we spent it to the output
                  cache.outputs[globalId].spent_relative_index =
                    onchainKeyImage.relative_index;
                  cache.outputs[globalId].spent_in_tx_hash =
                    onchainKeyImage.tx_hash;
                  cache.outputs[globalId].spent_block_height =
                    onchainKeyImage.block_height;
                  cache.outputs[globalId].spent_block_timestamp =
                    onchainKeyImage.block_timestamp;
                  ownspend.push(globalId);
                }
              }

              // scan only happens in one direction,
              // to scan earlier ranges: abort and recall with smaller start_height
              if (current_height > result.new_height)
                throw new Error(
                  "current scan height was larger than new height from latest scan result"
                );
              // 1. add new scanned range
              const newRange = {
                start: current_height,
                end: result.new_height,
              };
              cache.scanned_ranges.push(newRange);

              // 2. set new current_height value
              current_height = result.new_height;

              // 3. merge existing ranges & find end of current range
              cache.scanned_ranges = mergeRanges(cache.scanned_ranges);

              const fastForward = findRangeEnd(
                cache.scanned_ranges,
                current_height
              );

              if (fastForward) current_height = fastForward;
              await cacheChanged(cache, added, ownspend);
              return current_height;
            }
          },
          stopSync,
          stop_height
        );
      } catch (error) {
        // Treat AbortError as a normal, non-fatal outcome
        if (
          error &&
          typeof error === "object" &&
          (("name" in error && error.name === "AbortError") ||
            ("code" in error && error.code === 20))
        ) {
          console.log("Scan was aborted.");
          return;
        }
        console.log(
          error,
          "\n, scanWithCache in scanning-syncing/scanWithCache.ts`"
        );
        break;
      }
      // sleep for 1 second before calling scan() again
      // (scan call will send a getBlocks.bin request)
      await sleep(1000);
    }
  }
}
function mergeRanges(
  ranges: { start: number; end: number }[]
): { start: number; end: number }[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const last = merged[merged.length - 1];
    if (curr.start <= last.end) {
      last.end = Math.max(last.end, curr.end);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

const findRangeEnd = (
  ranges: { start: number; end: number }[],
  value: number
) => ranges.find((r) => value >= r.start && value < r.end)?.end ?? null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
