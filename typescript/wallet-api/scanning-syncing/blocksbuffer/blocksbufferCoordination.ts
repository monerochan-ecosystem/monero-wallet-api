import {
  findRange,
  get_block_headers_range,
  mergeRanges,
  NodeUrl,
  type BlockInfo,
  type CacheRange,
  type GetBlocksResultMeta,
  type ScanResult,
} from "../../api";
import type { ChangedOutput } from "../scanresult/scanCache";
import { readWriteConnectionStatusFile } from "../connectionStatus";
export type GetBlocksBinBufferItem = {
  start: number;
  end: number;
  filename: string;
  date: string;
  last_block_hash: string;
  get_blocks_result_meta: GetBlocksResultMeta;
};
export const MAX_BLOCKS_BUFFER_SIZE = 100000000000;
export async function blocksBufferCoordination(
  node_url: string,
  start_height: number,
  scan_settings_path?: string,
  max_blocks_buffer_size: number = MAX_BLOCKS_BUFFER_SIZE,
) {
  const nodeUrl = await NodeUrl.create(node_url);

  const get_blocks_bin = await nodeUrl.getBlocksBinExecuteRequest({});
  const result_meta = await nodeUrl.loadGetBlocksBinResponse();

  const connectionStatus = await readWriteConnectionStatusFile(async (cs) => {
    const { current_range, scanned_ranges } = await initScannedRanges(
      node_url,
      start_height,
      cs.sync.scanned_ranges,
    );
    cs.sync.scanned_ranges = scanned_ranges;
    cs.sync.current_range = current_range;
  }, scan_settings_path);
}

export async function initScannedRanges(
  node_url: string,
  start_height: number,
  scanned_ranges: CacheRange[] = [],
): Promise<{ current_range: CacheRange; scanned_ranges: CacheRange[] }> {
  {
    let current_height = start_height;

    // merge existing ranges & find end of current range
    scanned_ranges = mergeRanges(scanned_ranges);
    let current_range = findRange(scanned_ranges, current_height);
    let start_block_hash = current_range?.block_hashes[0];

    if (!start_block_hash) {
      const blockHeaderResponse = (
        await get_block_headers_range(node_url, {
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
      scanned_ranges.push(newRange);
    }
    if (!start_block_hash) throw new Error("could not find start block hash");

    if (current_range == null || !current_range?.block_hashes.length)
      throw new Error("current_range was malformed. block_hashes is empty");

    return { current_range, scanned_ranges };
  }
}

export function updateBlocksBufferScanHeight(
  current_range: CacheRange,
  result_meta: GetBlocksResultMeta,
  cache: ScanCache,
): [CacheRange, ChangedOutput[]] {
  let last_block_hash_of_result = result_meta.block_infos.at(-1);
  let current_blockhash = current_range?.block_hashes.at(0);
  if (!current_blockhash)
    throw new Error(
      "current_range passed to updateScanHeight was malformed. block_hashes is empty",
    );
  if (!last_block_hash_of_result) return [current_range, []]; // block_infos empty, no change (we are at tip and there was no new block)
  // if last blockhash is undefined it means there was not reorg, we are at tip, block_infos is empty ( no new blocks )

  const oldRange = findRange(
    cache.scanned_ranges,
    current_blockhash.block_height,
  );
  if (!oldRange)
    throw new Error(
      `could not find scan range for height ${current_blockhash.block_height},\n       that means the blocks in the response from getBlocks.bin do not overlap\n       with the scanned ranges in the cache. This should not happen, as even if \n       we are starting from a new start_height that has been supplied to scanWithCache,\n       it has been found as an existing range in the cache, or it has been\n       added as a new range before we started scannning.`,
    );
  // now we need to find the block_infos of old range in the new geblocksbin response result block_infos
  // if we cant find the new range, there was a reorg and we need to clean all outputs after that and log what happened
  let first_block_hash = result_meta.block_infos.at(0);
  if (!first_block_hash) return [current_range, []]; // should never happen, if there is last_block_hash there should be first_block_hash

  // if the first block hash in the response is not the same as the last block hash in the old range, there was a reorg
  if (!(first_block_hash.block_hash === current_blockhash.block_hash)) {
    // handleReorg only reads result.block_infos at runtime, so the cast is safe
    return handleReorg(
      //TODO update this to handle blocksbufferreorg
      current_range,
      result_meta as unknown as ScanResult,
      cache,
      oldRange,
    );
  }
  // scan only happens in one direction,
  // to scan earlier ranges: abort and recall with smaller start_height

  // getblocksbin will return up to 1000 blocks at once
  // so this should never happen, except if we just popped a block (but that case is handled above in the reorg case)
  if (current_blockhash.block_height > last_block_hash_of_result.block_height)
    throw new Error(
      `current scan height was larger than block height of last block from latest scan result. \n       Most likely connected to faulty node / catastrophic reorg.\n       current height: ${current_blockhash.block_height}, new height: ${last_block_hash_of_result.block_height}`,
    );

  // 1. add new scanned range
  let anchor: BlockInfo | undefined = undefined;
  let anchor_candidate: BlockInfo | undefined = undefined;
  if (oldRange.block_hashes.length >= 3) {
    const old_anchor = oldRange.block_hashes.at(-1);
    const old_anchor_candidate = oldRange.block_hashes.at(-2);
    anchor = old_anchor;
    anchor_candidate = old_anchor_candidate;

    if (
      // if the old range has an anchor, and the anchor is more than 200 blocks old
      typeof old_anchor?.block_height === "number" &&
      current_blockhash.block_height - old_anchor.block_height > 200
    ) {
      anchor = old_anchor_candidate; // use the anchor_candidate as anchor
      // new anchor_candidate: is the one 100 blocks in, or the old scan tip
      anchor_candidate =
        result_meta.block_infos.slice(-100)[0] || oldRange?.block_hashes.at(0); // use  use the old scan tip as anchor candidate
    }
  }
  // if there is no old anchor, use the one 100 blocks in, or the last block hash
  anchor =
    anchor ||
    result_meta.block_infos.slice(-100)[0] ||
    last_block_hash_of_result;
  // carry over the old anchor candidate or use the last block
  anchor_candidate = anchor_candidate || last_block_hash_of_result;
  const newRange = {
    start: current_blockhash.block_height,
    end: last_block_hash_of_result.block_height,
    block_hashes: [last_block_hash_of_result, anchor_candidate, anchor],
  };

  return [makeNewBlocksBufferScanRange(newRange, cache), []];
}

export function makeNewBlocksBufferScanRange(
  newRange: CacheRange,
  cache: ScanCache,
) {
  cache.scanned_ranges.push(newRange);

  // merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  // if we hit the end of a range we already scanned, move scan tip to the end
  const fastForward = findRange(cache.scanned_ranges, newRange.end);

  if (fastForward) return fastForward;
  return newRange;
}

export function handleReorg(
  current_range: CacheRange,
  result: ScanResult,
  cache: ScanCache,
  oldRange: CacheRange,
): [CacheRange, ChangedOutput[]] {
  let changed_outputs: ChangedOutput[] = [];

  // we need to check where anchor candidate is and if not found, try the same for anchor
  // if else throw on catastrophic reorg
  for (const block_hash of oldRange.block_hashes) {
    const split_height_index = result.block_infos.findIndex(
      (b) => b.block_hash === block_hash.block_hash,
    );
    const split_height = result.block_infos[split_height_index];

    // still a chance to find the split height, (could be candidate_anchor or anchor)
    if (!split_height) continue;

    // we found the split height & do the reorg
    const reorg_info: ReorgInfo = {
      split_height,
      removed_outputs: [],
      reverted_spends: [],
    };
    const removed_outputs = Object.entries(cache.outputs).filter(
      ([id, output]) => output.block_height >= split_height.block_height,
    );
    for (const [id, old_output_state] of removed_outputs) {
      // 1. find key_image of output to be removed (as it was reorged)
      const [key_image] = Object.entries(cache.own_key_images).find(
        ([own_key_image, globalid]) => globalid === id,
      ) || [""]; // if this is viewonly the key_image will be empty
      reorg_info.removed_outputs.push({ old_output_state, key_image });

      // 2. remove from outputs and own_key_images
      delete cache.outputs[id];
      delete cache.own_key_images[key_image];
      changed_outputs.push({
        output: old_output_state,
        change_reason: "reorged",
      });
    }

    //for reverted spents, just do the same again with spent_height
    const reverted_outputs = Object.entries(cache.outputs).filter(
      ([id, output]) =>
        output.spent_block_height !== undefined &&
        output.spent_block_height >= split_height.block_height,
    );

    for (const [id, old_output_state_pointer] of reverted_outputs) {
      const [key_image] = Object.entries(cache.own_key_images).find(
        ([own_key_image, globalid]) => globalid === id,
      ) || [""]; // if this is viewonly the key_image will be empty
      const old_output_state = Object.assign({}, old_output_state_pointer);
      reorg_info.reverted_spends.push({
        old_output_state,
        key_image, // in this case key_image only used here, does not get removed
      });

      // remove spend info from original cache
      delete cache.outputs[id].spent_relative_index;
      delete cache.outputs[id].spent_in_tx_hash;
      delete cache.outputs[id].spent_block_height;
      delete cache.outputs[id].spent_block_timestamp;
      changed_outputs.push({
        output: old_output_state,
        change_reason: "reorged_spent",
      });
    }

    // find current range in scanned ranges and change its end value + latest_block_hash
    oldRange.end = split_height.block_height;
    oldRange.block_hashes[0] = split_height;
    cache.reorg_info = reorg_info;
    // fix current_range
    let anchor: BlockInfo | undefined = result.block_infos.slice(-100)[0]; // if we got lots of new blocks
    const old_anchor = oldRange.block_hashes.at(-1);
    if (
      !anchor &&
      old_anchor &&
      split_height.block_height > old_anchor.block_height //if we did not get many new blocks + split height was candidate anchor
    ) {
      anchor = old_anchor; // we keep the anchor the same
    }
    if (!anchor) anchor = split_height;
    let last_block_hash_of_result = result.block_infos.at(-1)!;

    const end = last_block_hash_of_result.block_height;

    const start = current_range.start > end ? end : current_range.start;
    const newRange = {
      start,
      end,
      block_hashes: [last_block_hash_of_result, anchor, anchor],
    };
    return [makeNewBlocksBufferScanRange(newRange, cache), changed_outputs];
  }
  // we tried all the block hashes and could not find the split height

  throw new Error(
    "Could not find reorg split height. Most likely connected to faulty node / catastrophic reorg.",
  );
}
