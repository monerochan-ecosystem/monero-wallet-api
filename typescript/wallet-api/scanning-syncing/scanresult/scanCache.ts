import { type KeyImage } from "./computeKeyImage";
import type { ConnectionStatus } from "../connectionStatus";
import type { ReorgInfo } from "./reorg";
import type {
  BlockInfo,
  GetBlockHeadersRange,
  GetBlockHeadersRangeParams,
  Output,
} from "../../api";
import type { WasmProcessor } from "../../wasm-processing/wasmProcessor";

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
export interface HasGetBlockHeadersRangeMethod {
  getBlockHeadersRange: (
    params: GetBlockHeadersRangeParams
  ) => Promise<GetBlockHeadersRange>;
}

export interface HasPrimaryAddress {
  primary_address: string;
}
