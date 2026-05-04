import { type KeyImage } from "./computeKeyImage";
import type { ReorgInfo } from "./reorg";
import type {
  BlockInfo,
  FeeEstimateResponse,
  GetBlockHeadersRange,
  GetBlockHeadersRangeParams,
  Output,
  SendRawTransactionResult,
  ViewPair,
} from "../../api";
import { atomicWrite } from "../../io/atomicWrite";
import type { Payment } from "../../send-functionality/inputSelection";

export async function initScanCache(
  viewpair: ViewPair,
  start_height: number,
  scan_settings_path?: string,
  pathPrefix?: string,
): Promise<CacheRange> {
  const initialCache = await readCacheFileDefaultLocation(
    viewpair.primary_address,
    pathPrefix,
  );
  let cache: ScanCache = {
    daemon_height: 0,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: viewpair.primary_address,
  };
  if (initialCache) cache = initialCache;
  let current_height = start_height;

  // merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  let current_range = findRange(cache.scanned_ranges, current_height);
  let start_block_hash = current_range?.block_hashes[0];

  if (!start_block_hash) {
    const blockHeaderResponse = (
      await viewpair.getBlockHeadersRange({
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

  await viewpair.addSubaddressesToScanCache(cache, scan_settings_path);

  // write to cache
  await writeCacheToFile(cache, pathPrefix);

  return current_range;
}
export async function initScanCacheFile(
  viewpair: ViewPair,
  scan_settings_path?: string,
  pathPrefix?: string,
): Promise<ScanCache> {
  const initialCache = await readCacheFileDefaultLocation(
    viewpair.primary_address,
    pathPrefix,
  );
  let cache: ScanCache = {
    daemon_height: 0,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: viewpair.primary_address,
  };
  if (initialCache) cache = initialCache;

  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);

  await viewpair.addSubaddressesToScanCache(cache, scan_settings_path);

  // write to cache
  await writeCacheToFile(cache, pathPrefix);
  return cache;
}
export async function readCacheFile(
  cacheFilePath: string,
): Promise<ScanCache | undefined> {
  const jsonString = await Bun.file(cacheFilePath)
    .text()
    .catch(() => undefined);
  return jsonString
    ? (JSON.parse(jsonString, (key, value) => {
        if (key === "amount") return BigInt(value);
        return value;
      }) as ScanCache)
    : undefined;
}
export function cacheFileDefaultLocation(
  primary_address: string,
  pathPrefix?: string,
) {
  return `${pathPrefix ?? ""}${primary_address}_cache.json`;
}
export async function readCacheFileDefaultLocation(
  primary_address: string,
  pathPrefix?: string,
): Promise<ScanCache | undefined> {
  return await readCacheFile(
    cacheFileDefaultLocation(primary_address, pathPrefix),
  );
}
export type WriteCacheFileParams = {
  primary_address: string;
  pathPrefix?: string;
  writeCallback: (cache: ScanCache) => void | Promise<void>;
};
export async function writeCacheFileDefaultLocationThrows(
  params: WriteCacheFileParams,
) {
  const cache = await readCacheFileDefaultLocation(
    params.primary_address,
    params.pathPrefix,
  );
  if (!cache)
    throw new Error(
      `cache not found for primary address: ${params.primary_address}, and path prefix: ${params.pathPrefix}`,
    );
  await params.writeCallback(cache);
  // write to cache
  await writeCacheToFile(cache, params.pathPrefix);
}
export async function writeCacheToFile(cache: ScanCache, pathPrefix?: string) {
  // write to cache
  return await atomicWrite(
    cacheFileDefaultLocation(cache.primary_address, pathPrefix),
    JSON.stringify(
      cache,
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
}
export function lastRange(ranges: CacheRange[]): CacheRange | undefined {
  if (!ranges.length) return undefined;
  return ranges.reduce(
    (maxRange, current) => (current.end > maxRange.end ? current : maxRange),
    ranges[0],
  );
}
export function lastRangeThrows(ranges: CacheRange[]): CacheRange {
  if (!ranges.length) throw new Error("ranges is empty");
  return ranges.reduce(
    (maxRange, current) => (current.end > maxRange.end ? current : maxRange),
    ranges[0],
  );
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
  value: number,
): CacheRange | null =>
  ranges.find((r) => value >= r.start && value <= r.end) ?? null;
export function findRangeThrows(
  ranges: CacheRange[],
  value: number,
): CacheRange {
  const range = findRange(ranges, value);
  if (!range) throw new Error(`range not found for value: ${value}`);
  return range;
}
export type CacheRange = {
  start: number;
  end: number;
  block_hashes: BlockInfo[];
};

export type GlobalOutputId = string; // output.index_on_blockchain.toString()
export type OutputsCache = Record<GlobalOutputId, Output>; // { "123": Output, "456": Output } keyed by index_on_blockchain.toString()
export type OwnKeyImages = Record<KeyImage, GlobalOutputId>;
export type Subaddress = {
  minor: number;
  address: string;
  created_at_height: number;
  created_at_timestamp: number;
  not_yet_included?: boolean;
  received_amount?: bigint;
  pending_amount?: bigint;
};
export type ScanCache = {
  outputs: OutputsCache;
  own_key_images: OwnKeyImages;
  scanned_ranges: CacheRange[]; // list of block height ranges that have been scanned [0].start, [length-1].end <-- last scanned height
  primary_address: string;
  tx_logs?: TxLog[];
  pending_spent_utxos?: Record<GlobalOutputId, number>; // { "123": txlog index } mapping of utxo global index to txlog entry in tx_logs array
  subaddresses?: Subaddress[];
  reorg_info?: ReorgInfo;
  daemon_height: number;
};
export type TxLog = {
  inputs_index: string[];
  payments: Payment[];
  node_url: string;
  height: number;
  timestamp: number;
  feeEstimate?: FeeEstimateResponse;
  sendResult?: SendRawTransactionResult;
  error?: string;
};

export type ChangeReason =
  | "spent"
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
};
export type CacheChangedCallbackSync<R = void> = (
  params: CacheChangedCallbackParameters,
) => R;

export type CacheChangedCallbackAsync = CacheChangedCallbackSync<Promise<void>>;
/**
 * Callback invoked when the scan cache changes.
 *
 * @param params - The callback parameters.
 * @param params.newCache - The updated scan cache.
 * @param params.changed_outputs - Contains output and change_reason. {@link ChangedOutput}
 *
 */

export type CacheChangedCallback =
  | CacheChangedCallbackSync
  | CacheChangedCallbackAsync; // accept async callbacks
export interface HasGetBlockHeadersRangeMethod {
  getBlockHeadersRange: (
    params: GetBlockHeadersRangeParams,
  ) => Promise<GetBlockHeadersRange>;
}

export interface HasPrimaryAddress {
  primary_address: string;
}
export function handleScanError(error: unknown) {
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
      "\n, scanWithCache in scanning-syncing/scanWithCache.ts`",
    );
    throw error;
  }
}

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
