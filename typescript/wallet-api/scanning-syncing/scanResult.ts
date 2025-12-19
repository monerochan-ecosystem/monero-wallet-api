import type { Output } from "../api";
import {
  computeKeyImage,
  type KeyImage,
} from "../scanning-syncing/computeKeyImage";
import type { ScanCache, ChangedOutputs } from "./scanWithCache";

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
};

export async function detectOutputs(
  result: ScanResult,
  cache: ScanCache,
  spend_private_key?: string // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
) {
  let changed_outputs: ChangedOutputs[] = [];
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

export function detectOwnspends(result: ScanResult, cache: ScanCache) {
  let changed_outputs: ChangedOutputs[] = [];

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
  return !output.burned && !output.spent_relative_index;
}
