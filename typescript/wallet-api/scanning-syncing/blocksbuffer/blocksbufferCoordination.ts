import {
  cullTooLargeScanHeight,
  findRange,
  get_block_headers_range,
  mergeRanges,
  NodeUrl,
  sleep,
  type BlockInfo,
  type CacheRange,
  type GetBlocksResultMeta,
} from "../../api";
import { writeGetblocksBinBuffer } from "../scanresult/getBlocksbinBuffer";
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
  stopSync?: AbortSignal,
  pathPrefix?: string,
) {
  const nodeUrl = await NodeUrl.create(node_url);

  start_height = await cullTooLargeScanHeight(node_url, scan_settings_path);
  let connectionStatus = await readWriteConnectionStatusFile(async (cs) => {
    const { current_range, scanned_ranges } = await initScannedRanges(
      node_url,
      start_height,
      cs.sync.scanned_ranges,
    );
    cs.sync.scanned_ranges = scanned_ranges;
    cs.sync.current_range = current_range;
  }, scan_settings_path);
  while (true) {
    if (stopSync?.aborted) return;
    const get_blocks_bin = await nodeUrl.getBlocksBinExecuteRequest(
      {
        block_ids: connectionStatus.sync.current_range!.block_hashes.map(
          (b) => b.block_hash,
        ),
      },
      stopSync,
    );
    const result_meta = await nodeUrl.loadGetBlocksBinResponse(get_blocks_bin);
    const bufferItem = await writeGetblocksBinBuffer(
      get_blocks_bin,
      result_meta.block_infos,
      pathPrefix,
    );
    connectionStatus = await readWriteConnectionStatusFile(async (cs) => {
      const { current_range, scanned_ranges } =
        await updateBlocksBufferScanHeight(
          connectionStatus.sync.current_range!,
          result_meta,
          cs.sync.scanned_ranges,
          node_url,
          scan_settings_path,
        );
      cs.sync.scanned_ranges = scanned_ranges;
      cs.sync.current_range = current_range;
      if (bufferItem) {
        cs.sync.get_blocks_bin_buffer.push({
          ...bufferItem,
          get_blocks_result_meta: result_meta,
        });
      }
    }, scan_settings_path);
    if (result_meta.block_infos.length === 0) {
      await sleep(1000);
    }
  }
}
export type BlocksBufferScanStatus = {
  current_range: CacheRange;
  scanned_ranges: CacheRange[];
};

export async function initScannedRanges(
  node_url: string,
  start_height: number,
  scanned_ranges: CacheRange[] = [],
): Promise<BlocksBufferScanStatus> {
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

export async function updateBlocksBufferScanHeight(
  current_range: CacheRange,
  result_meta: GetBlocksResultMeta,
  scanned_ranges: CacheRange[],
  node_url: string,
  scan_settings_path?: string,
): Promise<BlocksBufferScanStatus> {
  let last_block_hash_of_result = result_meta.block_infos.at(-1);
  let current_blockhash = current_range?.block_hashes.at(0);
  if (!current_blockhash)
    throw new Error(
      "current_range passed to updateScanHeight was malformed. block_hashes is empty",
    );
  if (!last_block_hash_of_result) return { current_range, scanned_ranges }; // block_infos empty, no change (we are at tip and there was no new block)
  // if last blockhash is undefined it means there was not reorg, we are at tip, block_infos is empty ( no new blocks )

  const oldRange = findRange(scanned_ranges, current_blockhash.block_height);
  if (!oldRange)
    throw new Error(
      `could not find scan range for height ${current_blockhash.block_height},\n       that means the blocks in the response from getBlocks.bin do not overlap\n       with the scanned ranges in the cache. This should not happen, as even if \n       we are starting from a new start_height that has been supplied to scanWithCache,\n       it has been found as an existing range in the cache, or it has been\n       added as a new range before we started scannning.`,
    );
  // now we need to find the block_infos of old range in the new geblocksbin response result block_infos
  // if we cant find the new range, there was a reorg and we need to clean all outputs after that and log what happened
  let first_block_hash = result_meta.block_infos.at(0);
  if (!first_block_hash) return { current_range, scanned_ranges }; // block_infos empty, no change (we are at tip and there was no new block) current_range; // should never happen, if there is last_block_hash there should be first_block_hash

  // if the first block hash in the response is not the same as the last block hash in the old range, there was a reorg
  if (!(first_block_hash.block_hash === current_blockhash.block_hash)) {
    return await handleBlocksBufferReorg(
      current_range,
      result_meta,
      scanned_ranges,
      oldRange,
      node_url,
      scan_settings_path,
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

  return {
    current_range: makeNewBlocksBufferScanRange(newRange, scanned_ranges),
    scanned_ranges,
  };
}

export function makeNewBlocksBufferScanRange(
  newRange: CacheRange,
  scanned_ranges: CacheRange[],
): CacheRange {
  scanned_ranges.push(newRange);

  // merge existing ranges & find end of current range
  const merged = mergeRanges(scanned_ranges);
  scanned_ranges.length = 0;
  scanned_ranges.push(...merged);
  // if we hit the end of a range we already scanned, move scan tip to the end
  const fastForward = findRange(scanned_ranges, newRange.end);

  if (fastForward) return fastForward;
  return newRange;
}

export async function handleBlocksBufferReorg(
  current_range: CacheRange,
  result_meta: GetBlocksResultMeta,
  scanned_ranges: CacheRange[],
  oldRange: CacheRange,
  node_url: string,
  scan_settings_path?: string,
): Promise<BlocksBufferScanStatus> {
  // we need to check where anchor candidate is and if not found, try the same for anchor
  // if else throw on catastrophic reorg
  for (const block_hash of oldRange.block_hashes) {
    const split_height_index = result_meta.block_infos.findIndex(
      (b) => b.block_hash === block_hash.block_hash,
    );
    const split_height = result_meta.block_infos[split_height_index];

    // still a chance to find the split height, (could be candidate_anchor or anchor)
    if (!split_height) continue;
    //TODO write split height to connectionstatus.sync
    //TODO handle wallets reorg once we actually do CPU bound work based on the fetched blocks

    // we found the split height
    // find current range in scanned ranges and change its end value + latest_block_hash
    oldRange.end = split_height.block_height;
    oldRange.block_hashes[0] = split_height;
    // fix current_range
    let anchor: BlockInfo | undefined = result_meta.block_infos.slice(-100)[0]; // if we got lots of new blocks
    const old_anchor = oldRange.block_hashes.at(-1);
    if (
      !anchor &&
      old_anchor &&
      split_height.block_height > old_anchor.block_height //if we did not get many new blocks + split height was candidate anchor
    ) {
      anchor = old_anchor; // we keep the anchor the same
    }
    if (!anchor) anchor = split_height;
    let last_block_hash_of_result = result_meta.block_infos.at(-1)!;

    const end = last_block_hash_of_result.block_height;

    const start = current_range.start > end ? end : current_range.start;
    const newRange = {
      start,
      end,
      block_hashes: [last_block_hash_of_result, anchor, anchor],
    };
    return {
      current_range: makeNewBlocksBufferScanRange(newRange, scanned_ranges),
      scanned_ranges,
    };
  }
  // we tried all the block hashes and could not find the split height

  await readWriteConnectionStatusFile((cs) => {
    cs.last_packet = {
      status: "catastrophic_reorg",
      bytes_read: 0,
      node_url,
      timestamp: new Date().toISOString(),
    };
  }, scan_settings_path);

  throw new Error(
    "Could not find reorg split height. Most likely connected to faulty node / catastrophic reorg.",
  );
}
