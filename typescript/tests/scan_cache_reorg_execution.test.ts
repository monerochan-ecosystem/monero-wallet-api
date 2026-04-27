import { test, expect } from "bun:test";
import { handleReorg } from "../wallet-api/scanning-syncing/scanresult/reorg";
import type { CacheRange, ScanCache, ChangedOutput } from "../wallet-api/scanning-syncing/scanresult/scanCache";
import type { ScanResult, BlockInfo } from "../wallet-api/api";

test("handleReorg captures reverted spends for outputs that are also removed", () => {
  // the anchor block the old range recognised as common ancestor
  const anchorBlock: BlockInfo = {
    block_hash: "anchor_hash",
    block_height: 50,
    block_timestamp: 1000,
  };

  // the tip of the old chain before the reorg
  const oldTip: BlockInfo = {
    block_hash: "old_tip_hash",
    block_height: 100,
    block_timestamp: 2000,
  };

  // the range the wallet thought it had scanned before the reorg
  const currentRange: CacheRange = {
    start: 1,
    end: 100,
    block_hashes: [oldTip, anchorBlock, { block_hash: "genesis", block_height: 0, block_timestamp: 0 }],
  };

  // the scan result from the new chain
  // it includes the anchor (same hash, so the split is found) then new blocks after it
  const result: Partial<ScanResult> = {
    outputs: [],
    all_key_images: [],
    new_height: 101,
    primary_address: "test",
    block_infos: [
      anchorBlock,
      { block_hash: "new_51", block_height: 51, block_timestamp: 1050 },
      { block_hash: "new_52", block_height: 52, block_timestamp: 1100 },
      { block_hash: "new_53", block_height: 53, block_timestamp: 1150 },
      { block_hash: "new_54", block_height: 54, block_timestamp: 1200 },
      { block_hash: "new_55", block_height: 55, block_timestamp: 1250 },
      { block_hash: "new_56", block_height: 56, block_timestamp: 1300 },
      { block_hash: "new_57", block_height: 57, block_timestamp: 1350 },
      { block_hash: "new_58", block_height: 58, block_timestamp: 1400 },
      { block_hash: "new_59", block_height: 59, block_timestamp: 1450 },
      { block_hash: "new_60", block_height: 60, block_timestamp: 1500 },
      { block_hash: "new_61", block_height: 61, block_timestamp: 1550 },
      { block_hash: "new_62", block_height: 62, block_timestamp: 1600 },
      { block_hash: "new_63", block_height: 63, block_timestamp: 1650 },
      { block_hash: "new_64", block_height: 64, block_timestamp: 1700 },
      { block_hash: "new_65", block_height: 65, block_timestamp: 1750 },
      { block_hash: "new_66", block_height: 66, block_timestamp: 1800 },
      { block_hash: "new_67", block_height: 67, block_timestamp: 1850 },
      { block_hash: "new_68", block_height: 68, block_timestamp: 1900 },
      { block_hash: "new_69", block_height: 69, block_timestamp: 1950 },
      { block_hash: "new_70", block_height: 70, block_timestamp: 2001 },
      { block_hash: "new_71", block_height: 71, block_timestamp: 2051 },
      { block_hash: "new_72", block_height: 72, block_timestamp: 2101 },
      { block_hash: "new_73", block_height: 73, block_timestamp: 2151 },
      { block_hash: "new_74", block_height: 74, block_timestamp: 2201 },
      { block_hash: "new_75", block_height: 75, block_timestamp: 2251 },
      { block_hash: "new_76", block_height: 76, block_timestamp: 2301 },
      { block_hash: "new_77", block_height: 77, block_timestamp: 2351 },
      { block_hash: "new_78", block_height: 78, block_timestamp: 2401 },
      { block_hash: "new_79", block_height: 79, block_timestamp: 2451 },
      { block_hash: "new_80", block_height: 80, block_timestamp: 2501 },
      { block_hash: "new_81", block_height: 81, block_timestamp: 2551 },
      { block_hash: "new_82", block_height: 82, block_timestamp: 2601 },
      { block_hash: "new_83", block_height: 83, block_timestamp: 2651 },
      { block_hash: "new_84", block_height: 84, block_timestamp: 2701 },
      { block_hash: "new_85", block_height: 85, block_timestamp: 2751 },
      { block_hash: "new_86", block_height: 86, block_timestamp: 2801 },
      { block_hash: "new_87", block_height: 87, block_timestamp: 2851 },
      { block_hash: "new_88", block_height: 88, block_timestamp: 2901 },
      { block_hash: "new_89", block_height: 89, block_timestamp: 2951 },
      { block_hash: "new_90", block_height: 90, block_timestamp: 3001 },
      { block_hash: "new_91", block_height: 91, block_timestamp: 3051 },
      { block_hash: "new_92", block_height: 92, block_timestamp: 3101 },
      { block_hash: "new_93", block_height: 93, block_timestamp: 3151 },
      { block_hash: "new_94", block_height: 94, block_timestamp: 3201 },
      { block_hash: "new_95", block_height: 95, block_timestamp: 3251 },
      { block_hash: "new_96", block_height: 96, block_timestamp: 3301 },
      { block_hash: "new_97", block_height: 97, block_timestamp: 3351 },
      { block_hash: "new_98", block_height: 98, block_timestamp: 3401 },
      { block_hash: "new_99", block_height: 99, block_timestamp: 3451 },
      { block_hash: "new_100", block_height: 100, block_timestamp: 3501 },
      { block_hash: "new_101", block_height: 101, block_timestamp: 3551 },
    ],
    daemon_height: 102,
  };

  // the wallet's cache before the reorg with three outputs:
  //   0: created at height 10 (below split), spent at height 100 (above split)
  //   1: created at height 100 (above split), spent at height 100 (above split)
  //   2: created at height 30 (below split), never spent
  const cache: ScanCache = {
    daemon_height: 101,
    primary_address: "test",
    outputs: {
      "0": {
        amount: 100000000000n,
        block_height: 10,
        block_timestamp: 100,
        index_in_transaction: 0,
        index_on_blockchain: 0,
        is_miner_tx: true,
        payment_id: 0,
        primary_address: "test",
        serialized: "",
        stealth_address: "stealth_0",
        subaddress_index: null,
        tx_hash: "tx_0",
        spent_block_height: 100,
        spent_in_tx_hash: "spend_tx",
        spent_relative_index: 0,
        spent_block_timestamp: 2000,
      },
      "1": {
        amount: 50000000000n,
        block_height: 100,
        block_timestamp: 2000,
        index_in_transaction: 0,
        index_on_blockchain: 1,
        is_miner_tx: true,
        payment_id: 0,
        primary_address: "test",
        serialized: "",
        stealth_address: "stealth_1",
        subaddress_index: null,
        tx_hash: "tx_1",
        spent_block_height: 100,
        spent_in_tx_hash: "spend_tx",
        spent_relative_index: 1,
        spent_block_timestamp: 2000,
      },
      "2": {
        amount: 70000000000n,
        block_height: 30,
        block_timestamp: 500,
        index_in_transaction: 0,
        index_on_blockchain: 2,
        is_miner_tx: true,
        payment_id: 0,
        primary_address: "test",
        serialized: "",
        stealth_address: "stealth_2",
        subaddress_index: null,
        tx_hash: "tx_2",
      },
    },
    own_key_images: {
      "ki_0": "0",
      "ki_1": "1",
      "ki_2": "2",
    },
    scanned_ranges: [currentRange],
  };

  const [newRange, changedOutputs] = handleReorg(currentRange, result as ScanResult, cache, currentRange);

  expect(cache.reorg_info).toBeDefined();
  const reorgInfo = cache.reorg_info!;

  // split should be at block 50 (the anchor)
  expect(reorgInfo.split_height.block_height).toBe(50);

  // removed_outputs: only outputs with block_height >= 50
  // output 0 (height 10) stays, output 1 (height 100) goes, output 2 (height 30) stays
  expect(reorgInfo.removed_outputs.length).toBe(1);
  expect(reorgInfo.removed_outputs[0].old_output_state.index_on_blockchain).toBe(1);

  // reverted_spends: outputs with spent_block_height >= 50
  // output 0 (spent at 100, height 10) is reverted
  // output 1 (spent at 100, height 100) is ALSO reverted even though it's removed
  //   this was the bug: output 1 was missed because we checked after deleting it
  // output 2 (never spent) is not reverted
  expect(reorgInfo.reverted_spends.length).toBe(2);

  const revertedIds = reorgInfo.reverted_spends.map(
    (r) => r.old_output_state.index_on_blockchain,
  );
  expect(revertedIds).toContain(0);
  expect(revertedIds).toContain(1);

  // output 1 belongs to both arrays
  const removedIds = reorgInfo.removed_outputs.map(
    (r) => r.old_output_state.index_on_blockchain,
  );
  expect(removedIds).toContain(1);
  expect(revertedIds).toContain(1);

  // after reorg, output 0 (height 10 < 50) stays in cache with spend info cleared
  expect(cache.outputs["0"]).toBeDefined();
  expect(cache.outputs["0"].spent_block_height).toBeUndefined();
  expect(cache.outputs["0"].spent_in_tx_hash).toBeUndefined();

  // output 1 (height 100 >= 50) is removed from cache entirely
  expect(cache.outputs["1"]).toBeUndefined();

  // output 2 (height 30 < 50, never spent) stays unchanged
  expect(cache.outputs["2"]).toBeDefined();
  expect(cache.outputs["2"].spent_block_height).toBeUndefined();

  // changed_outputs has both reorg and reorged_spent reasons
  const changeReasons = changedOutputs.map((c) => c.change_reason);
  expect(changeReasons).toContain("reorged");
  expect(changeReasons).toContain("reorged_spent");
  expect(changeReasons.filter((r) => r === "reorged_spent").length).toBe(2);
});
