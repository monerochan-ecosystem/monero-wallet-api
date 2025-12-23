import type {
  BlockInfo,
  ErrorResponse,
  GetBlockHeadersRange,
  GetBlockHeadersRangeParams,
  GetBlocksBinMetaCallback,
  GetBlocksBinRequest,
  Output,
  ScanResult,
  ScanResultCallback,
} from "../api";
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
  block_hashes: BlockInfo[];
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
    HasGetBlocksBinExecuteRequestMethod &
    HasGetBlocksBinScanResponseMethod &
    HasGetBlockHeadersRangeMethod &
    HasPrimaryAddress &
    HasConnectionStatus
>(
  processor: T,
  start_height: number,
  initialCache?: ScanCache,
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  stopSync?: AbortSignal,
  spend_private_key?: string // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
) {
  let [cache, current_range] = initScanCache(
    processor.primary_address,
    start_height,
    initialCache
  );
  let start_block_hash = current_range?.block_hashes[0];

  if (!start_block_hash) {
    const blockHeaderResponse = (
      await processor.getBlockHeadersRange({
        start_height,
        end_height: start_height,
      })
    ).headers[0];

    start_block_hash = {
      block_hash: blockHeaderResponse.hash,
      block_height: blockHeaderResponse.height,
      block_timestamp: blockHeaderResponse.timestamp,
    };
  }
  if (!start_block_hash) throw new Error("could not find start block hash");

  let current_blockhash = start_block_hash;
  await scanLoop();
  async function scanLoop() {
    while (true) {
      try {
        const firstResponse = await processor.getBlocksBinExecuteRequest(
          {
            block_ids: [current_blockhash.block_hash],
          },
          stopSync
        );
        const result = await processor.getBlocksBinScanResponse(firstResponse);
        // res.block_infos
        if (result && "new_height" in result) {
          const changed_outputs = await detectOutputs(
            result,
            cache,
            spend_private_key
          );

          if (spend_private_key)
            changed_outputs.push(...detectOwnspends(result, cache));
          current_blockhash = updateScanHeight(
            current_blockhash,
            result,
            cache
          );
          await cacheChanged({
            newCache: cache,
            changed_outputs,
            connection_status: processor.connection_status,
          });

          if (result.block_infos.length === 0) {
            // we are at the tip, and there are no new blocks
            // sleep for 1 second before sending another
            // getBlocks.bin request
            //
            await sleep(1000);
          }
        }
      } catch (error) {
        await cacheChanged({
          newCache: cache,
          changed_outputs: [],
          connection_status: processor.connection_status,
        });
        handleScanError(error);
      }
    }
  }
}
function initScanCache(
  primary_address: string,
  start_height: number,
  initialCache?: ScanCache
): [ScanCache, CacheRange | null] {
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
  const fastForward = findRange(cache.scanned_ranges, current_height);
  return [cache, fastForward];
}
function updateScanHeight(
  current_blockhash: BlockInfo,
  result: ScanResult,
  cache: ScanCache
) {
  const last_block_hash = result.block_infos.at(-1);
  if (!last_block_hash) return current_blockhash; // block_infos empty, no change (we are at tip and there was no new block)
  // scan only happens in one direction,
  // to scan earlier ranges: abort and recall with smaller start_height
  if (current_blockhash.block_height > result.new_height)
    throw new Error(
      "current scan height was larger than new height from latest scan result"
    );
  const oldRange = findRange(
    cache.scanned_ranges,
    current_blockhash.block_height
  );
  // 1. add new scanned range
  let anchor: BlockInfo | undefined = undefined;
  let anchor_candidate: BlockInfo | undefined = undefined;
  if (oldRange && oldRange.block_hashes.length >= 3) {
    const old_anchor = oldRange?.block_hashes.at(-1);
    const old_anchor_candidate = oldRange?.block_hashes.at(-2);
    anchor = old_anchor;
    anchor_candidate = old_anchor_candidate;

    if (
      // if the old range has an anchor, and the anchor is more than 200 blocks old
      old_anchor?.block_height &&
      current_blockhash.block_height - old_anchor?.block_height > 200
    ) {
      anchor = old_anchor_candidate; // use the anchor_candidate as anchor
      // new anchor_candidate: is the one 100 blocks in, or the old scan tip
      anchor_candidate =
        result.block_infos.slice(-100)[0] || oldRange?.block_hashes.at(0); // use  use the old scan tip as anchor candidate
    }
  }
  // if there is no old anchor, use the one 100 blocks in, or the last block hash
  anchor = anchor || result.block_infos.slice(-100)[0] || last_block_hash;
  // carry over the old anchor candidate or use the last block
  anchor_candidate = anchor_candidate || last_block_hash;
  const newRange = {
    start: current_blockhash.block_height,
    end: last_block_hash.block_height,
    block_hashes: [last_block_hash, anchor_candidate, anchor],
  };
  cache.scanned_ranges.push(newRange);

  // 2. set new current_height value
  current_blockhash = last_block_hash;

  // 3. merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  // if we hit the end of a range we already scanned, move scan tip to the end
  const fastForward = findRange(
    cache.scanned_ranges,
    current_blockhash.block_height
  );

  if (fastForward) current_blockhash = fastForward.block_hashes[0];
  return current_blockhash;
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
function mergeRanges(ranges: CacheRange[]): CacheRange[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const last = merged[merged.length - 1];
    // If last range overlaps or touches current range
    if (curr.start <= last.end) {
      // Extend last range to cover both (take max end value)
      last.end = Math.max(last.end, curr.end);
      last.block_hashes = curr.block_hashes;
    } else {
      // No overlap: add current range as new merged interval
      merged.push(curr);
    }
  }
  return merged;
}
// find the cache range that contains the given height, if not found return null
const findRange = (ranges: CacheRange[], value: number): CacheRange | null =>
  ranges.find((r) => value >= r.start && value <= r.end) ?? null;

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
export interface HasGetBlocksBinExecuteRequestMethod {
  getBlocksBinExecuteRequest: (
    params: GetBlocksBinRequest,
    stopSync?: AbortSignal
  ) => Promise<Uint8Array<ArrayBufferLike>>;
}

export interface HasGetBlocksBinScanResponseMethod {
  getBlocksBinScanResponse: (
    getBlocksBinResponseBuffer: Uint8Array<ArrayBufferLike>,
    metaCallBack?: GetBlocksBinMetaCallback
  ) => Promise<ScanResult | ErrorResponse | undefined>;
}
export interface HasGetBlockHeadersRangeMethod {
  getBlockHeadersRange: (
    params: GetBlockHeadersRangeParams
  ) => Promise<GetBlockHeadersRange>;
}

export interface HasPrimaryAddress {
  primary_address: string;
}
export interface HasConnectionStatus {
  connection_status: ConnectionStatus;
}
