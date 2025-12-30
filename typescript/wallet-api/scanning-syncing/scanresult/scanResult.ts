import type { BlockInfo, Output } from "../../api";
import { computeKeyImage, type KeyImage } from "./computeKeyImage";
import { mergeRanges, findRange } from "./scanCache";
import { type ErrorResponse } from "../../node-interaction/binaryEndpoints";
import { handleReorg } from "./reorg";
import type { ConnectionStatus } from "../connectionStatus";
import type {
  CacheChangedCallback,
  CacheRange,
  ChangedOutput,
  ScanCache,
} from "./scanCache";
import { sleep } from "../../io/sleep";

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
  let last_block_hash = result.block_infos.at(-1);
  let current_blockhash = current_range?.block_hashes.at(0);
  if (!current_blockhash)
    throw new Error(
      "current_range passed to updateScanHeight was malformed. block_hashes is empty"
    );
  if (!last_block_hash) last_block_hash = current_blockhash; // block_infos empty, no change (we are at tip and there was no new block)
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
  let first_block_hash = result.block_infos.at(0);
  if (!first_block_hash) first_block_hash = current_blockhash; // should never happen, if there is last_block_hash there should be first_block_hash

  // if the first block hash in the response is not the same as the last block hash in the old range, there was a reorg
  if (
    !(
      first_block_hash.block_hash === current_blockhash.block_hash &&
      first_block_hash.block_height === current_blockhash.block_height
    )
  ) {
    return handleReorg(current_range, result, cache, oldRange);
  }
  // scan only happens in one direction,
  // to scan earlier ranges: abort and recall with smaller start_height

  // getblocksbin will return up to 1000 blocks at once
  // so this should never happen, except if we just popped a block (but that case is handled above in the reorg case)
  if (current_blockhash.block_height > last_block_hash.block_height)
    throw new Error(
      `current scan height was larger than block height of last block from latest scan result. 
       Most likely connected to faulty node / catastrophic reorg.
       current height: ${current_blockhash.block_height}, new height: ${last_block_hash.block_height}`
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
  return [current_range, []];
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
