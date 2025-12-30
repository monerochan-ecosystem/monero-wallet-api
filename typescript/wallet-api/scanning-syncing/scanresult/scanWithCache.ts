import type {
  BlockInfo,
  ErrorResponse,
  GetBlockHeadersRange,
  GetBlockHeadersRangeParams,
  GetBlocksBinMetaCallback,
  GetBlocksBinRequest,
  Output,
  ScanResult,
} from "../../api";
import type { WasmProcessor } from "../../wasm-processing/wasmProcessor";
import { type KeyImage } from "./computeKeyImage";
import type { ConnectionStatus } from "../connectionStatus";
import { detectOutputs, detectOwnspends, updateScanHeight } from "./scanResult";
import type { ReorgInfo } from "./reorg";
import { atomicWrite } from "../../io/atomicWrite";
import {
  createSlaveFeeder,
  updateGetBlocksBinBuffer,
  type BlocksGenerator,
  type MasterSlaveInit,
} from "./getBlocksbinBuffer";

/**
 * Scans blockchain from `start_height` using the provided processor and using the provided initialCachePath file path,
 *  invoking callback cacheChanged() for results and cache changes
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param initialCachePath: string - Optional initial scan cache file path. (will get created if it does not exist)
 * @param scan_params.start_height - Starting block height for the scan
 * @param scan_params.cacheChanged - params: {newCache,changed_outputs,connection_status} {@link CacheChangedCallback} invoked when cache changes {@link CacheChangedCallbackParameters}
 * @param scan_params.stopSync - Optional abort signal to stop scanning
 * @param scan_params.spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 */
export async function scanWithCacheFile<
  T extends WasmProcessor & HasScanWithCacheMethod
>(
  processor: T,
  initialCachePath: string,
  scan_params: ScanParams,
  masterSlaveInit?: MasterSlaveInit,
  pathPrefix?: string
) {
  if (pathPrefix) initialCachePath = pathPrefix + initialCachePath;
  const suppliedCallback = scan_params.cacheChanged;
  const initialScanCache = await readCacheFile(initialCachePath);
  const cacheCallback: CacheChangedCallback = async (params) => {
    await atomicWrite(
      initialCachePath,
      JSON.stringify(params.newCache, null, 2)
    );
    if (suppliedCallback) await suppliedCallback(params);
  };
  scan_params.cacheChanged = cacheCallback;
  await processor.scanWithCache(
    scan_params,
    initialScanCache,
    masterSlaveInit,
    pathPrefix
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
export async function readCacheFileDefaultLocation(
  primary_address: string,
  pathPrefix?: string
): Promise<ScanCache | undefined> {
  return await readCacheFile(
    `${pathPrefix ?? ""}${primary_address}_cache.json`
  );
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
  reorg_info?: ReorgInfo;
};

export type ChangeReason =
  | "added"
  | "ownspend"
  | "reorged"
  | "reorged_spent"
  | "burned";
export type ChangedOutput = {
  output: Output;
  change_reason: ChangeReason;
};

export type CacheChangedCallbackParameters = {
  newCache: ScanCache;
  changed_outputs: ChangedOutput[];
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
 * @param params.changed_outputs - Contains output and change_reason. {@link ChangedOutput}
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
 * Scan parameters for blockchain scanning with caching.
 *
 * @param start_height - Starting block height for the scan
 * @param initialCache - Optional initial scan cache
 * @param cacheChanged - Callback invoked when cache changes
 * @param stopSync - Optional abort signal to stop scanning
 * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 */
export type ScanParams = {
  /** Starting block height for the scan */
  start_height: number;
  /** Callback invoked when cache changes */
  cacheChanged?: CacheChangedCallback;
  /** Optional abort signal to stop scanning */
  stopSync?: AbortSignal;
  /** Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged()) */
  spend_private_key?: string;
};

/**
 * Scans blockchain from `start_height` using the provided processor and params,
 * invoking callback cacheChanged() for results and cache changes.
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param params - Scanning configuration {@link ScanParams}
 * @param initialCache - (optional) initial scan cache to start syncing from
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
  params: ScanParams,
  initialCache?: ScanCache,
  masterSlaveInit?: MasterSlaveInit,
  pathPrefix?: string
) {
  const {
    start_height,
    cacheChanged = (params) => console.log(params),
    stopSync,
    spend_private_key,
  } = params;
  let [cache, current_range] = await initScanCache(
    processor,
    start_height,
    initialCache
  );
  let blockGenerator: BlocksGenerator | undefined;

  if (masterSlaveInit && "foodFromMaster" in masterSlaveInit) {
    blockGenerator = createSlaveFeeder(
      current_range.end,
      masterSlaveInit.foodFromMaster,
      pathPrefix
    );
  }
  const defaultBlockGenerator: BlocksGenerator = (async function* () {
    const range = current_range;
    while (true) {
      if (stopSync?.aborted) return;
      const firstResponse = await processor.getBlocksBinExecuteRequest(
        { block_ids: range.block_hashes.map((b) => b.block_hash) },
        stopSync
      );

      yield firstResponse;
    }
  })();

  try {
    for await (const firstResponse of blockGenerator ??
      (defaultBlockGenerator as AsyncGenerator<Uint8Array>)) {
      if (!firstResponse) continue;
      console.log("primary address", processor.primary_address);
      const result = await processor.getBlocksBinScanResponse(firstResponse);
      current_range = await processScanResult(
        current_range,
        result,
        cache,
        cacheChanged,
        processor.connection_status,
        spend_private_key
      );
      await updateGetBlocksBinBuffer(
        masterSlaveInit,
        firstResponse,
        result,
        pathPrefix
      );
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
export async function processScanResult(
  current_range: CacheRange,
  result: ScanResult | ErrorResponse | undefined,
  cache: ScanCache,
  cacheChanged: CacheChangedCallback,
  connection_status: ConnectionStatus,
  spend_private_key?: string
) {
  if (result && "new_height" in result) {
    const [new_range, changed_outputs] = updateScanHeight(
      current_range,
      result,
      cache
    );
    current_range = new_range;

    changed_outputs.push(
      ...(await detectOutputs(result, cache, spend_private_key))
    );

    if (spend_private_key)
      changed_outputs.push(...detectOwnspends(result, cache));
    await cacheChanged({
      newCache: cache,
      changed_outputs,
      connection_status,
    });

    if (result.block_infos.length === 0) {
      // we are at the tip, and there are no new blocks
      // sleep for 1 second before sending another
      // getBlocks.bin request
      //
      await sleep(1000);
    }
  }
  return current_range;
}
export async function initScanCache<
  T extends WasmProcessor & HasGetBlockHeadersRangeMethod & HasPrimaryAddress
>(
  processor: T,
  start_height: number,
  initialCache?: ScanCache
): Promise<[ScanCache, CacheRange]> {
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
  let current_range = findRange(cache.scanned_ranges, current_height);
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
    const newRange = {
      start: start_block_hash.block_height,
      end: start_block_hash.block_height,
      block_hashes: [start_block_hash, start_block_hash, start_block_hash],
    };
    current_range = newRange;
    cache.scanned_ranges.push(newRange);
  }
  if (!start_block_hash) throw new Error("could not find start block hash");

  if (current_range == null || !current_range?.block_hashes.length)
    throw new Error("current_range was malformed. block_hashes is empty");
  return [cache, current_range];
}

function handleScanError(error: unknown) {
  // treat errno 0 code "ConnectionRefused" as non fatal outcome, and rethrow,
  // so that UI can be informed after catching it higher up
  if (isConnectionError(error)) {
    console.log("Scan stopped. node might be offline. Connection Refused");
    throw error;
  }
  // Treat AbortError as a normal, non-fatal outcome
  if (
    error &&
    typeof error === "object" &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === 20))
  ) {
    console.log("Scan was aborted.");
    return;
  } else {
    console.log(
      error,
      "\n, scanWithCache in scanning-syncing/scanWithCache.ts`"
    );
    throw error;
  }
}
export function mergeRanges(ranges: CacheRange[]): CacheRange[] {
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
export const findRange = (
  ranges: CacheRange[],
  value: number
): CacheRange | null =>
  ranges.find((r) => value >= r.start && value <= r.end) ?? null;

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

export interface HasScanWithCacheMethod {
  scanWithCache: (
    params: ScanParams,
    initialCache?: ScanCache,
    masterSlaveInit?: MasterSlaveInit,
    pathPrefix?: string
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
