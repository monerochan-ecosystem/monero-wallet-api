import type { BlockInfo, Output } from "../../api";
import type { KeyImage } from "./computeKeyImage";
import type { ScanResult } from "./scanResult";
import type { CacheRange, ChangedOutput, ScanCache } from "./scanCache";
export type ReorgInfo = {
  split_height: BlockInfo;
  removed_outputs: ReorgedOutput[]; // Copies of detached outputs for logging
  reverted_spends: ReorgedOutput[]; // Outputs that became unspent again
};
export type ReorgedOutput = {
  old_output_state: Output;
  key_image: KeyImage;
};
export function handleReorg(
  current_range: CacheRange,
  result: ScanResult,
  cache: ScanCache,
  oldRange: CacheRange
): [CacheRange, ChangedOutput[]] {
  let changed_outputs: ChangedOutput[] = [];

  // we need to check where anchor candidate is and if not found, try the same for anchor
  // if else throw on catastrophic reorg
  for (const block_hash of oldRange.block_hashes) {
    const split_height_index = result.block_infos.findIndex(
      (b) => b.block_hash === block_hash.block_hash
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
  // we tried all the block hashes and could not find the split height

  throw new Error(
    "Could not find reorg split height. Most likely connected to faulty node / catastrophic reorg."
  );
}
