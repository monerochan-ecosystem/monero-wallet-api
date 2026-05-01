import {
  findRange,
  get_block_headers_range,
  get_info,
  mergeRanges,
  NodeUrl,
  sleep,
  type BlockInfo,
  type CacheRange,
  type GetBlocksResultMeta,
} from "../../api";
import {
  type ConnectionSatusLastPacket,
  type ConnectionStatus,
  type ConnectionStatusSync,
} from "../connectionStatus";
export type GetBlocksBinBufferItem = {
  local_uuid: string;
  get_blocks_result_meta: GetBlocksResultMeta;
  data: Uint8Array;
};
export const MAX_BLOCKS_BUFFER_SIZE = 10;

// runs forever, fetching blocks from the node.
// handles scan level reorg detection and catastrophic reorg
export async function* blocksBufferFetchLoop(
  node_url: string,
  start_height: number,
  blocks_buffer: GetBlocksBinBufferItem[], // pass by reference
  connection_status: ConnectionStatus, // we make a local copy of this and pass last_packet and sync updates seperately
  max_blocks_buffer_size: number = MAX_BLOCKS_BUFFER_SIZE,
  stopSync?: AbortSignal,
): AsyncGenerator<
  | ConnectionSatusLastPacket
  | ConnectionStatusSync
  // | ConnectionStatus
  | "blocks_buffer_changed"
> {
  connection_status = structuredClone(connection_status);
  const nodeUrl = await NodeUrl.create(node_url);
  console.log("[blocksBufferFetchLoop] NodeUrl created, fetching info...");

  start_height = await reduceStartHeightToTip(start_height, nodeUrl.node_url);
  // initialise ranges on first call
  let { current_range, scanned_ranges } = await initScannedRanges(
    nodeUrl.node_url,
    start_height,
    connection_status.sync.scanned_ranges,
  );
  connection_status.sync.scanned_ranges = scanned_ranges;
  connection_status.last_packet = {
    status: "no_connection_yet",
    bytes_read: 0,
    node_url: nodeUrl.node_url,
    timestamp: new Date().toISOString(),
  };
  yield connection_status.last_packet;

  while (true) {
    // avoid overwriting last_packet in case of catastrophic reorg
    // this generator will block on this. coordinator should rethrow the CatastrophicReorgError
    if (connection_status.last_packet.status === "catastrophic_reorg") {
      yield connection_status.last_packet;
      continue;
    }
    if (blocks_buffer.length >= max_blocks_buffer_size) {
      connection_status.last_packet = {
        status: "blocks_buffer_full",
        bytes_read: 0,
        node_url: node_url,
        timestamp: new Date().toISOString(),
      };
      await sleep(1000);
    }
    console.log("[blocksBufferFetchLoop] fetching from current_range...");
    const get_blocks_bin = await doRPCrequest(nodeUrl, current_range, stopSync);

    const result_meta = await nodeUrl.loadGetBlocksBinResponse(get_blocks_bin);
    console.log(
      "[blocksBufferFetchLoop] response: " +
        result_meta.block_infos.length +
        " blocks",
    );
    connection_status.last_packet = {
      status: "OK",
      bytes_read: get_blocks_bin.length,
      node_url: node_url,
      timestamp: new Date().toISOString(),
    };
    yield connection_status.last_packet;
    // no new blocks: at tip, sleep and retry
    if (!result_meta.block_infos.length) {
      await sleep(1000);
      continue;
    }
    const bufferItem = makeBlocksBufferItem(result_meta, get_blocks_bin);
    try {
      const parse_result = await updateBlocksBufferScanHeight(
        current_range,
        result_meta,
        connection_status.sync.scanned_ranges,
      );
      connection_status.sync.scanned_ranges = parse_result.scanned_ranges;
      current_range = parse_result.current_range;
      if (parse_result.split_height) {
        // push a new ReorgInfo entry for this reorg
        if (!connection_status.sync.reorg_info) {
          connection_status.sync.reorg_info = {
            split_heights: [parse_result.split_height],
            removed_outputs: [],
            reverted_spends: [],
          };
        } else {
          connection_status.sync.reorg_info.split_heights.push(
            parse_result.split_height,
          );
        }
        //pop blocks that were reorged
        //then push new blocks
        popBlocksBufferItemsFromSplitHeight(
          blocks_buffer,
          parse_result.split_height,
        );
        blocks_buffer.push(bufferItem);
        yield "blocks_buffer_changed";
      } else {
        blocks_buffer.push(bufferItem);
        yield "blocks_buffer_changed";
      }

      yield connection_status.sync;
    } catch (error) {
      //cat reorg
      if (error instanceof CatastrophicReorgError) {
        connection_status.last_packet = {
          status: "catastrophic_reorg",
          bytes_read: 0,
          node_url,
          timestamp: new Date().toISOString(),
        };
        yield connection_status.last_packet;
      } else {
        throw error;
      }
    }
  }
}

export function makeBlocksBufferItem(
  result_meta: GetBlocksResultMeta,
  get_blocks_bin: Uint8Array,
) {
  const bufferItem: GetBlocksBinBufferItem = {
    local_uuid: crypto.randomUUID(),
    data: get_blocks_bin,
    get_blocks_result_meta: result_meta,
  };
  return bufferItem;
}
export function popBlocksBufferItemFromIndex(
  blocks_buffer: GetBlocksBinBufferItem[],
  index: number,
) {
  if (index < 0 || index >= blocks_buffer.length) return;
  return blocks_buffer.splice(index, 1)[0];
}
export function findBufferitemBySplitHeight(
  blocks_buffer: GetBlocksBinBufferItem[],
  split_height: BlockInfo,
): GetBlocksBinBufferItem | undefined {
  for (const item of blocks_buffer) {
    const infos = item.get_blocks_result_meta.block_infos;
    if (!infos?.length) continue;
    const start = infos[0].block_height;
    const end = infos.at(-1)!.block_height;
    if (
      start <= split_height.block_height &&
      split_height.block_height <= end
    ) {
      return item;
    }
  }
}
export function findBufferItemIndexByLocalId(
  blocks_buffer: GetBlocksBinBufferItem[],
  local_uuid: string,
): number | undefined {
  return blocks_buffer.findIndex((item) => item.local_uuid === local_uuid);
}
export function popBlocksBufferItemsFromSplitHeight(
  blocks_buffer: GetBlocksBinBufferItem[],
  split_height: BlockInfo,
): GetBlocksBinBufferItem[] {
  const found = findBufferitemBySplitHeight(blocks_buffer, split_height);
  if (!found) {
    throw new CatastrophicReorgError(
      "could not find split height in blocks buffer: " +
        split_height.block_height,
    );
  }
  const foundIndex = findBufferItemIndexByLocalId(
    blocks_buffer,
    found.local_uuid,
  );
  if (!foundIndex || foundIndex < 0) {
    throw new CatastrophicReorgError(
      "could not find split height in blocks buffer: " +
        split_height.block_height,
    );
  }
  // pop from this index onward, everything at or above the split
  const removed: GetBlocksBinBufferItem[] = [];
  for (let i = blocks_buffer.length - 1; i >= foundIndex; i--) {
    removed.unshift(popBlocksBufferItemFromIndex(blocks_buffer, i)!);
  }
  return removed;
}
export async function doRPCrequest(
  nodeUrl: NodeUrl,
  current_range: CacheRange,
  stopSync?: AbortSignal,
) {
  const get_blocks_bin = await nodeUrl.getBlocksBinExecuteRequest(
    {
      block_ids: current_range.block_hashes.map((b) => b.block_hash),
    },
    stopSync,
  );
  return get_blocks_bin;
}
export type BlocksBufferScanStatus = {
  current_range: CacheRange;
  scanned_ranges: CacheRange[];
};
export type BlocksBufferReorgResult = BlocksBufferScanStatus & {
  split_height?: BlockInfo;
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
): Promise<BlocksBufferReorgResult> {
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

  // guard against degenerate single-block ranges
  if (
    current_blockhash.block_height === last_block_hash_of_result.block_height
  ) {
    oldRange.end = last_block_hash_of_result.block_height;
    oldRange.block_hashes[0] = last_block_hash_of_result;
    return { current_range: oldRange, scanned_ranges };
  }

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
): Promise<BlocksBufferReorgResult> {
  // we need to check where anchor candidate is and if not found, try the same for anchor
  // if else throw on catastrophic reorg
  for (const block_hash of oldRange.block_hashes) {
    const split_height_index = result_meta.block_infos.findIndex(
      (b) => b.block_hash === block_hash.block_hash,
    );
    const split_height = result_meta.block_infos[split_height_index];

    // still a chance to find the split height, (could be candidate_anchor or anchor)
    if (!split_height) continue;

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
    // preserve the old deep anchor (3rd element) so subsequent reorgs
    // have a fallback beyond the split height. without this, both anchors
    // point to the same height and the next pop past it is catastrophic.
    const oldDeepAnchor = oldRange.block_hashes.at(-1);
    const newAnchor =
      oldDeepAnchor && oldDeepAnchor.block_height < anchor.block_height
        ? oldDeepAnchor
        : anchor;
    const newRange = {
      start,
      end,
      block_hashes: [last_block_hash_of_result, anchor, newAnchor],
    };
    return {
      current_range: makeNewBlocksBufferScanRange(newRange, scanned_ranges),
      scanned_ranges,
      split_height,
    };
  }
  // we tried all the block hashes and could not find the split height

  throw new CatastrophicReorgError(
    "Could not find reorg split height. Most likely connected to faulty node / catastrophic reorg.",
  );
}
/**
 * getBlocks.bin monero RPC call will block clients as peers,
 * after 3 attempts of fetching a height higher than tip,
 * this is ugly but it is what it is, so we need to do a get_info
 * rpc call to get the tip height and reduce the start_height to the tip height,
 * if it is larger than the tip height
 * @param start_height
 * @param node_url
 * @returns Promise<number>  a promise with the new potentially reduced start_height
 */
export async function reduceStartHeightToTip(
  start_height: number,
  node_url: string,
): Promise<number> {
  const getInfo = await get_info(node_url);

  if (start_height > getInfo.height - 1) {
    const oldStartHeight = start_height;
    start_height = getInfo.height - 1;
    console.log(
      "[reduceStartHeightToTip] start height was larger than daemon height, setting start_height=" +
        start_height,
      " oldStartHeight=" + oldStartHeight,
    );
  }

  return start_height;
}

export class CatastrophicReorgError extends Error {
  name = "CatastrophicReorgError";
}
