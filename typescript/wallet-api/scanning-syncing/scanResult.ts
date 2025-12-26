import type { BlockInfo, Output } from "../api";
import {
  computeKeyImage,
  type KeyImage,
} from "../scanning-syncing/computeKeyImage";
import {
  type ScanCache,
  type ChangedOutput,
  mergeRanges,
  findRange,
  type ReorgInfo,
  type CacheRange,
} from "./scanWithCache";
import { type ErrorResponse } from "../node-interaction/binaryEndpoints";
export type OnchainKeyImage = {
  key_image_hex: KeyImage;
  relative_index: number; // relative index of input in transaction
  tx_hash: string;
  block_hash: string;
  block_height: number;
  block_timestamp: number;
};
export type ScanResult = {
  outputs: Output[];
  all_key_images: OnchainKeyImage[];
  new_height: number;
  primary_address: string;
  block_infos: BlockInfo[];
  daemon_height: number;
};
export type EmptyScanResult = {}; // can happen when we abort a scan before any blocks are processed

export type FastForward = number; // height to fast forward scan to
/**
 * we will await async callbacks. convenient way to halt a sync + feed back the key image list,
 * to look out for our own spends before proceeding the scan. This happens in the scanWithCache function.
 */
export type ScanResultCallback =
  | ((
      result: ScanResult | ErrorResponse | EmptyScanResult
    ) => FastForward | void)
  | ((
      result: ScanResult | ErrorResponse | EmptyScanResult
    ) => Promise<FastForward | void>); // accept async callbacks
export function updateScanHeight(
  current_range: CacheRange,
  result: ScanResult,
  cache: ScanCache
): [CacheRange, ChangedOutput[]] {
  let changed_outputs: ChangedOutput[] = [];

  const last_block_hash = result.block_infos.at(-1);
  let current_blockhash = current_range?.block_hashes.at(0);
  if (!current_blockhash)
    throw new Error(
      "current_range passed to updateScanHeight was malformed. block_hashes is empty"
    );
  if (!last_block_hash) return [current_range, changed_outputs]; // block_infos empty, no change (we are at tip and there was no new block)
  // if last blockhash is undefined it means there was not reorg, we are at tip, block_infos is empty ( no new blocks )

  const oldRange = findRange(
    cache.scanned_ranges,
    current_blockhash.block_height
  );
  if (!oldRange)
    throw new Error(
      `could not find scan range for height ${current_blockhash.block_height},
       that means the blocks in the response from getBlocks.bin do not overlap
       with the scanned ranges in the cache. This should not happen, as even if 
       we are starting from a new start_height that has been supplied to scanWithCache,
       it has been found as an existing range in the cache, or it has been
       added as a new range before we started scannning.`
    );
  // now we need to find the block_infos of old range in the new geblocksbin response result block_infos
  // if we cant find the new range, there was a reorg and we need to clean all outputs after that and log what happened
  const first_block_hash = result.block_infos.at(0);
  if (!first_block_hash)
    throw new Error("no first block hash in getBlocks.bin response"); // should never happen, if there is last_block_hash there should be first_block_hash

  // if the first block hash in the response is not the same as the last block hash in the old range, there was a reorg
  if (
    !(
      first_block_hash.block_hash === current_blockhash.block_hash &&
      first_block_hash.block_height === current_blockhash.block_height
    )
  ) {
    // we need to check where anchor candidate is and if not found, try the same for anchor
    // if else throw on catastrophic reorg
    for (const [index, block_hash] of oldRange.block_hashes.entries()) {
      const split_height_index = result.block_infos.findIndex(
        (b) => b.block_hash === block_hash.block_hash
      );
      const split_height = result.block_infos[split_height_index];
      // we tried all the block hashes and could not find the split height
      if (!split_height && index === oldRange.block_hashes.length - 1)
        throw new Error(
          "Could not find reorg split height. Most likely connected to faulty node / catastrophic reorg."
        );
      // still a chance to find the split height, (could be candidate_anchor or anchor)
      if (!split_height) continue;

      // we found the split height & do the reorg
      const reorg_info: ReorgInfo = {
        split_height,
        removed_outputs: [],
        reverted_spends: [],
      };
      const removed_outputs = Object.entries(cache.outputs).filter(
        ([id, output]) => output.block_height >= split_height.block_height
      );
      for (const [id, old_output_state] of removed_outputs) {
        // 1. find key_image of output to be removed (as it was reorged)
        const [key_image] = Object.entries(cache.own_key_images).find(
          ([own_key_image, globalid]) => globalid === id
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
          output.spent_block_height >= split_height.block_height
      );

      for (const [id, old_output_state_pointer] of reverted_outputs) {
        const [key_image] = Object.entries(cache.own_key_images).find(
          ([own_key_image, globalid]) => globalid === id
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
      return [current_range, changed_outputs];
    }
  }
  // scan only happens in one direction,
  // to scan earlier ranges: abort and recall with smaller start_height

  // getblocksbin will return up to 1000 blocks at once
  // so this should never happen, except if we just popped a block (but that case is handled above in the reorg case)
  if (current_blockhash.block_height > result.new_height)
    throw new Error(
      `current scan height was larger than new height from latest scan result. 
       Most likely connected to faulty node / catastrophic reorg.
       current_height: ${current_blockhash.block_height}, new_height: ${result.new_height}`
    );

  // 1. add new scanned range
  let anchor: BlockInfo | undefined = undefined;
  let anchor_candidate: BlockInfo | undefined = undefined;
  if (oldRange.block_hashes.length >= 3) {
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
  current_range = newRange;

  // 3. merge existing ranges & find end of current range
  cache.scanned_ranges = mergeRanges(cache.scanned_ranges);
  // if we hit the end of a range we already scanned, move scan tip to the end
  const fastForward = findRange(
    cache.scanned_ranges,
    last_block_hash.block_height
  );

  if (fastForward) current_range = fastForward;
  return [current_range, changed_outputs];
}
// Assumption: result is new, cache is still old. (this + detectOwnspends() turns the catch new, based on the scan result)
export async function detectOutputs(
  result: ScanResult,
  cache: ScanCache,
  spend_private_key?: string // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
) {
  let changed_outputs: ChangedOutput[] = [];
  for (const output of result.outputs) {
    // TODO: extract into own function detectOutput()

    // 0. prevent burning bug and avoid overwriting earlier found outputs
    const duplicate = Object.values(cache.outputs).find(
      (ex) => ex.stealth_address === output.stealth_address && !ex.burned
      // we expect to find only one output that could be a duplicate.
      // we don't care about all the burned duplicates already inserted.
    );

    let burned = false;
    if (duplicate?.index_on_blockchain !== output.index_on_blockchain) {
      burned = true;
    }

    if (duplicate && burned) {
      //mark burned output
      const existingIndex = duplicate.index_on_blockchain;
      const liveIndex = Math.min(existingIndex, output.index_on_blockchain);
      if (liveIndex === existingIndex) {
        output.burned = existingIndex;
      } else {
        duplicate.burned = output.index_on_blockchain;
      }
      // here we add to changed_outputs with reason burned
      changed_outputs.push({ output, change_reason: "burned" });
    } else if (duplicate && !burned) {
      continue; // if it is just a duplicate we continue the loop to avoid overwriting (ereasing spent status)
    }

    // 1. add to outputs cache 2. add to added array for cacheChanged callback
    const globalId = output.index_on_blockchain.toString();
    cache.outputs[globalId] = output;
    //here we add to changed_outputs with reason added
    changed_outputs.push({ output, change_reason: "added" });

    // 3. if this is not view only, add the key image to the cache, to find transactions spent by this wallet
    if (spend_private_key) {
      let keyImage = await computeKeyImage(output, spend_private_key);
      if (keyImage) {
        cache.own_key_images[keyImage] = globalId;
      }
    }
  }
  return changed_outputs;
}
// Assumption: result is new, cache is still old. (this + detectOutputs() turns the catch new, based on the scan result)
export function detectOwnspends(result: ScanResult, cache: ScanCache) {
  let changed_outputs: ChangedOutput[] = [];

  for (const onchainKeyImage of result.all_key_images) {
    // TODO: extract into own function detectOwnSpend()
    if (onchainKeyImage.key_image_hex in cache.own_key_images) {
      // this is one of ours
      const globalId = cache.own_key_images[onchainKeyImage.key_image_hex];
      // add the information where we spent it to the output
      cache.outputs[globalId].spent_relative_index =
        onchainKeyImage.relative_index;
      cache.outputs[globalId].spent_in_tx_hash = onchainKeyImage.tx_hash;
      cache.outputs[globalId].spent_block_height = onchainKeyImage.block_height;
      cache.outputs[globalId].spent_block_timestamp =
        onchainKeyImage.block_timestamp;
      //here we add to changed_outputs with reason ownspend
      changed_outputs.push({
        output: cache.outputs[globalId],
        change_reason: "ownspend",
      });
    }
  }
  return changed_outputs;
}

export function spendable(output: Output) {
  return (
    !(typeof output.burned === "number") &&
    !(typeof output.spent_in_tx_hash === "string")
  );
}
