import type { Output, ScanResult, ScanResultCallback } from "../api";
import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
import { type KeyImage } from "./computeKeyImage";
import type { ConnectionStatus } from "./connectionStatus";
import { detectOutputs, detectOwnspends } from "./scanResult";

/**
 * Scans blockchain from `start_height` using the provided processor and using the provided initialCachePath file path,
 *  invoking callback cacheChanged() for results and cache changes
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param start_height - Starting block height for the scan
 * @param initialCachePath: string - Optional initial scan cache file path. (will get created if it does not exist)
 * @param cacheChanged - params: {newCache,changed_outputs,connection_status} {@link CacheChangedCallback} invoked when cache changes {@link CacheChangedCallbackParameters}
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
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  stopSync?: AbortSignal,
  spend_private_key?: string, // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
  stop_height: number | null = null
) {
  const initialScanCache = await readCacheFile(initialCachePath);
  const cacheCallback: CacheChangedCallback = async (params) => {
    await Bun.write(initialCachePath, JSON.stringify(params.newCache, null, 2));
    await cacheChanged(params);
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
export async function readCacheFile(
  cacheFilePath: string
): Promise<ScanCache | undefined> {
  const jsonString = await Bun.file(cacheFilePath)
    .text()
    .catch(() => undefined);
  return jsonString ? (JSON.parse(jsonString) as ScanCache) : undefined;
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
export type ChangeReason = "added" | "ownspend" | "reorged" | "burned";
export type ChangedOutputs = {
  output: Output;
  change_reason: ChangeReason;
};

export type CacheChangedCallbackParameters = {
  newCache: ScanCache;
  changed_outputs: ChangedOutputs[];
  connection_status: ConnectionStatus;
};
export type CacheChangedCallbackSync<R = void> = (
  params: CacheChangedCallbackParameters
) => R;

export type CacheChangedCallbackAsync = CacheChangedCallbackSync<Promise<void>>;
/**
 * Callback invoked when the scan cache changes.
 *
 * @param params - The callback parameters.
 * @param params.newCache - The updated scan cache.
 * @param params.changed_outputs - Contains output and change_reason. {@link ChangedOutputs}
 *
 * @param params.connection_status - Connection status information.
 * @param params.connection_status.status_updates - Array of connection status messages:
 * - { message: "node_url_changed"; old_node_url: string; new_node_url: string }
 * - { message: "connection_error"; error: {} }
 * - { message: "connection_ok" }
 * - undefined
 *
 * @param params.connection_status.last_packet - Information about the last packet:
 * `{ connection_status: "OK" | "partial read" | "connection failed"; bytes_read: number; node_url: string; timestamp: string }`.
 *
 * @remarks
 * - `scanned_ranges` is expected to change on every invocation,
 *   except when there was a connection error, then only `connection_status` changes.
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
 * @param cacheChanged - params: {newCache,changed_outputs,connection_status} {@link CacheChangedCallback} invoked when cache changes {@link CacheChangedCallbackParameters}
 * @param stopSync - Optional abort signal to stop scanning
 * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 * @param stop_height - Optional ending block height (null = keep scanning)
 */
export async function scanWithCache<
  T extends WasmProcessor &
    HasScanMethod &
    HasPrimaryAddress &
    HasConnectionStatus
>(
  processor: T,
  start_height: number,
  initialCache?: ScanCache,
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  stopSync?: AbortSignal,
  spend_private_key?: string, // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
  stop_height: number | null = null
) {
  let [cache, current_height] = initScanCache(
    processor.primary_address,
    start_height,
    initialCache
  );
  await scanLoop();
  async function scanLoop() {
    while (true) {
      try {
        await processor.scan(
          current_height,
          async (result) => {
            // TODO: turn this into a function as well, so we dont need to repeat it in a scanMany call
            if ("new_height" in result) {
              const changed_outputs = await detectOutputs(
                result,
                cache,
                spend_private_key
              );

              if (spend_private_key)
                changed_outputs.push(...detectOwnspends(result, cache));

              current_height = updateScanHeight(current_height, result, cache);
              await cacheChanged({
                newCache: cache,
                changed_outputs,
                connection_status: processor.connection_status,
              });
              return current_height;
            }
          },
          stopSync,
          stop_height
        );
      } catch (error) {
        await cacheChanged({
          newCache: cache,
          changed_outputs: [],
          connection_status: processor.connection_status,
        });
        handleScanError(error);
      }
      // sleep for 1 second before calling scan() again
      // (scan call will send a getBlocks.bin request)
      await sleep(1000);
    }
  }
}
function initScanCache(
  primary_address: string,
  start_height: number,
  initialCache?: ScanCache
) {
  let cache: ScanCache = {
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address,
  };
  if (initialCache) cache = initialCache;
  let current_height = start_height;
  // merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  const fastForward = findRangeEnd(cache.scanned_ranges, current_height);
  if (fastForward) current_height = fastForward;

  return [cache, current_height] as [ScanCache, number];
}
function updateScanHeight(
  current_height: number,
  result: ScanResult,
  cache: ScanCache
) {
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

  const fastForward = findRangeEnd(cache.scanned_ranges, current_height);

  if (fastForward) current_height = fastForward;
  return current_height;
}
function handleScanError(error: unknown) {
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
  // treat errno 0 code "ConnectionRefused" as non fatal outcome, and rethrow,
  // so that UI can be informed after catching it higher up
  if (isConnectionError(error)) {
    console.log("Scan stopped. node might be offline. Connection Refused");
    throw error;
  }
  console.log(error, "\n, scanWithCache in scanning-syncing/scanWithCache.ts`");
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

export function isConnectionError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    (("code" in error && error.code === "ConnectionRefused") ||
      ("errno" in error && error.errno === 0))
  ) {
    return true;
  } else {
    false;
  }
}

export interface HasScanWithCacheFileMethod {
  scanWithCacheFile: (
    start_height: number,
    initialCachePath: string,
    cacheChanged?: CacheChangedCallback,
    stopSync?: AbortSignal,
    spend_private_key?: string,
    stop_height?: number | null
  ) => Promise<void>;
}
export interface HasScanWithCacheMethod {
  scanWithCache: (
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
export interface HasConnectionStatus {
  connection_status: ConnectionStatus;
}
