/**
 * unit tests for processScanResultWITHOUT_SIDE_EFFECTS idempotency.
 *
 * scanning wallets with different scan ranges that overlap with the same
 * result must still produce valid, conflict-free caches. the prepended mock
 * blocks tests verify this by simulating overlap. mock blocks before the
 * real blocks simulate the already scanned range that the wallet should skip.
 */
import { test, expect } from "bun:test";
import {
  processScanResultWITHOUT_SIDE_EFFECTS,
  type ScanResult,
  type ScanCache,
  type CacheRange,
  type BlockInfo,
} from "../../../dist/api";
import type { Output } from "../../../dist/api";

function blockInfo(height: number, hash?: string): BlockInfo {
  return {
    block_height: height,
    block_hash: hash ?? `hash_${height}`,
    block_timestamp: 1000,
  };
}

function makeCache(start: number, end: number, addr: string): ScanCache {
  return {
    primary_address: addr,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [
      {
        start,
        end,
        block_hashes: [blockInfo(end), blockInfo(start), blockInfo(start)],
      },
    ],
    daemon_height: end + 50,
  };
}

function makeRange(start: number, end: number): CacheRange {
  return {
    start,
    end,
    block_hashes: [blockInfo(end), blockInfo(start), blockInfo(start)],
  };
}

function makeOutput(height: number, addr: string): Output {
  return {
    amount: BigInt(height * 1000),
    block_height: height,
    block_timestamp: 1000,
    index_in_transaction: 0,
    index_on_blockchain: height * 10,
    payment_id: 0,
    stealth_address: `stealth_${height}`,
    tx_hash: `tx_${height}`,
    is_miner_tx: true,
    primary_address: addr,
    subaddress_index: null,
    serialized: "0".repeat(64),
  };
}

function makeResult(
  start: number,
  end: number,
  addr: string,
  addOutputs: boolean,
  prependCount: number,
): ScanResult {
  const infos: BlockInfo[] = [];
  for (let i = 0; i < prependCount; i++) {
    infos.push(blockInfo(start - prependCount + i, `pre_hash_${i}`));
  }
  for (let i = start; i <= end; i++) infos.push(blockInfo(i));
  const outputs: Output[] = [];
  if (addOutputs) {
    for (let i = start + 1; i <= end; i++) outputs.push(makeOutput(i, addr));
  }
  return {
    outputs,
    all_key_images: [],
    new_height: end,
    primary_address: addr,
    block_infos: infos,
    daemon_height: end + 50,
  };
}

function jsonLen(c: any): number {
  return JSON.stringify(c, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ).length;
}

function fmt(c: ScanCache): string {
  const r = c.scanned_ranges?.[0];
  if (!r) return "no range";
  return `range=[${r.start},${r.end}] outputs=${Object.keys(c.outputs).length} bh0=${r.block_hashes[0]?.block_height}`;
}

// 1a: apply the same result twice

test("1a: same result applied twice, compare cache after first and second call", async () => {
  const cache = makeCache(100, 150, "addr1");
  const result = makeResult(150, 160, "addr1", true, 0);
  const current = makeRange(100, 150);
  const initial = structuredClone(cache);

  console.log("[test 1a] before call 1:", fmt(cache));

  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result,
    scanCache: cache,
    secret_spend_key: undefined,
  });
  const after1 = structuredClone(cache);
  console.log("[test 1a] after call 1:", fmt(after1));

  // verify call 1 actually modified the cache, not a no op
  expect(after1).not.toEqual(initial);
  console.log("[test 1a] call 1 modified cache");

  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result,
    scanCache: cache,
    secret_spend_key: undefined,
  });
  const after2 = structuredClone(cache);
  console.log("[test 1a] after call 2:", fmt(after2));

  expect(after2).toEqual(after1);
  console.log("[test 1a] call 2 idempotent, same as call 1");
  // sanity: json length should not grow between idempotent calls
  expect(jsonLen(cache)).toBe(jsonLen(after1));
});

// 1b: same result applied 5 times

test("1b: same result applied 5 times, compare after each to first call", async () => {
  const cache = makeCache(100, 150, "addr1");
  const result = makeResult(150, 155, "addr1", true, 0);
  const current = makeRange(100, 150);
  const initial = structuredClone(cache);

  let first: ScanCache | null = null;

  for (let i = 0; i < 5; i++) {
    await processScanResultWITHOUT_SIDE_EFFECTS({
      current_range: current,
      result,
      scanCache: cache,
      secret_spend_key: undefined,
    });
    const clone = structuredClone(cache);
    console.log(`[test 1b] call ${i + 1}:`, fmt(clone));

    if (!first) {
      first = clone;
      // verify call 1 actually modified the cache
      expect(clone).not.toEqual(initial);
      console.log(`[test 1b] call 1 modified cache`);
    } else {
      expect(clone).toEqual(first);
      console.log(`[test 1b] call ${i + 1} idempotent, same as call 1`);
    }
  }
  // sanity: json length should not grow between idempotent calls
  expect(jsonLen(cache)).toBe(jsonLen(first!));
});

// 2a: 10 mock blocks prepended vs no prepend

test("2a: apply result with 10 prepended blocks, compare to result without prepend", async () => {
  const current = makeRange(100, 150);

  const cacheNo = makeCache(100, 150, "addr1");
  const initialNo = structuredClone(cacheNo);
  const resultNo = makeResult(150, 160, "addr1", true, 0);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultNo,
    scanCache: cacheNo,
    secret_spend_key: undefined,
  });
  console.log("[test 2a] without prepend after call 1:", fmt(cacheNo));
  expect(cacheNo).not.toEqual(initialNo);
  console.log("[test 2a] without-prepend call modified cache");

  const cachePre = makeCache(100, 150, "addr1");
  const initialPre = structuredClone(cachePre);
  const resultPre = makeResult(150, 160, "addr1", true, 10);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultPre,
    scanCache: cachePre,
    secret_spend_key: undefined,
  });
  console.log("[test 2a] with 10 prepended after call 1:", fmt(cachePre));
  expect(cachePre).not.toEqual(initialPre);
  console.log("[test 2a] prepended call modified cache");

  // both should produce the same final state. this fails because
  // prepended blocks trigger handleReorg, corrupting block_hashes
  expect(cachePre).toEqual(cacheNo);
  console.log(
    "[test 2a] json length cachePre:",
    jsonLen(cachePre),
    "cacheNo:",
    jsonLen(cacheNo),
  );
});

// 2b: varying prepend counts all produce same final cache

test("2b: apply with 0, 5, 20 prepended blocks to same fresh cache", async () => {
  const current = makeRange(100, 150);
  let reference: ScanCache | null = null;

  for (const n of [0, 5, 20]) {
    const cache = makeCache(100, 150, "addr1");
    const initial = structuredClone(cache);
    const result = makeResult(150, 160, "addr1", true, n);
    await processScanResultWITHOUT_SIDE_EFFECTS({
      current_range: current,
      result,
      scanCache: cache,
      secret_spend_key: undefined,
    });
    console.log(`[test 2b] prepend ${n} after call:`, fmt(cache));
    expect(cache).not.toEqual(initial);
    console.log(`[test 2b] prepend ${n} modified cache`);

    if (!reference) {
      reference = structuredClone(cache);
      console.log("[test 2b] reference set from prepend 0");
    } else {
      console.log(`[test 2b] prepend ${n} vs reference...`);
      expect(cache).toEqual(reference);
    }
  }
  // sanity: log final json length
  console.log("[test 2b] final json length:", jsonLen(reference));
});

// 3a: prepended 2x then without prepend 1x on same cache

test("3a: prepended 2x then without prepend 1x, cache same as single without", async () => {
  const current = makeRange(100, 150);

  const cacheRef = makeCache(100, 150, "addr1");
  const initialRef = structuredClone(cacheRef);
  const resultRef = makeResult(150, 155, "addr1", true, 0);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultRef,
    scanCache: cacheRef,
    secret_spend_key: undefined,
  });
  console.log("[test 3a] reference (no prepend, 1x):", fmt(cacheRef));
  expect(cacheRef).not.toEqual(initialRef);
  console.log("[test 3a] reference call modified cache");

  const cacheTest = makeCache(100, 150, "addr1");
  const initialTest = structuredClone(cacheTest);
  const resultPre = makeResult(150, 155, "addr1", true, 10);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultPre,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3a] after first prepended call:", fmt(cacheTest));
  expect(cacheTest).not.toEqual(initialTest);
  console.log("[test 3a] first prepended call modified cache");

  const afterFirstPre = structuredClone(cacheTest);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultPre,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3a] after second prepended call:", fmt(cacheTest));
  expect(cacheTest).toEqual(afterFirstPre);
  console.log("[test 3a] second prepended call idempotent");

  const afterSecondPre = structuredClone(cacheTest);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultRef,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3a] after final without-prepend call:", fmt(cacheTest));
  expect(cacheTest).toEqual(afterSecondPre);
  console.log("[test 3a] final without-prepend call idempotent");

  // should converge to same state as reference. this fails because reorg_info
  // and block_hashes are corrupted by the prepended block calls
  expect(cacheTest).toEqual(cacheRef);
  console.log(
    "[test 3a] json length cacheTest:",
    jsonLen(cacheTest),
    "cacheRef:",
    jsonLen(cacheRef),
  );
});

// 3b: without prepend 2x then prepended 1x on same cache

test("3b: without prepend 2x then prepended 1x, cache same as 3a", async () => {
  const current = makeRange(100, 150);

  const cacheTest = makeCache(100, 150, "addr1");
  const initialTest = structuredClone(cacheTest);
  const resultRef = makeResult(150, 155, "addr1", true, 0);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultRef,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3b] after first without-prepend call:", fmt(cacheTest));
  expect(cacheTest).not.toEqual(initialTest);
  console.log("[test 3b] first without-prepend call modified cache");

  const afterFirst = structuredClone(cacheTest);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultRef,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3b] after second without-prepend call:", fmt(cacheTest));
  expect(cacheTest).toEqual(afterFirst);
  console.log("[test 3b] second without-prepend call idempotent");

  const resultPre = makeResult(150, 155, "addr1", true, 10);
  const afterSecond = structuredClone(cacheTest);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultPre,
    scanCache: cacheTest,
    secret_spend_key: undefined,
  });
  console.log("[test 3b] after final prepended call:", fmt(cacheTest));
  expect(cacheTest).not.toEqual(afterSecond);
  console.log("[test 3b] final prepended call modified cache");

  const cacheRef = makeCache(100, 150, "addr1");
  const initialRef = structuredClone(cacheRef);
  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result: resultRef,
    scanCache: cacheRef,
    secret_spend_key: undefined,
  });
  console.log("[test 3b] reference (no prepend, 1x):", fmt(cacheRef));
  expect(cacheRef).not.toEqual(initialRef);
  console.log("[test 3b] reference call modified cache");

  // should converge to same state as reference. this fails because prepended
  // call corrupts the cache with reorg_info and wrong block_hashes
  expect(cacheTest).toEqual(cacheRef);
  console.log(
    "[test 3b] json length cacheTest:",
    jsonLen(cacheTest),
    "cacheRef:",
    jsonLen(cacheRef),
  );
});

// 4a: output pollution from prepended blocks

test("4a: outputs from prepended blocks should not pollute cache", async () => {
  const current = makeRange(100, 150);
  const cache = makeCache(100, 150, "addr1");
  const initial = structuredClone(cache);

  // build result with 10 prepended blocks that also have outputs
  const result = makeResult(150, 160, "addr1", true, 10);
  // add fake outputs for the prepended blocks (heights 141 to 149)
  for (let h = 141; h <= 149; h++) {
    result.outputs.push({
      amount: BigInt(h * 1000),
      block_height: h,
      block_timestamp: 1000,
      index_in_transaction: 0,
      index_on_blockchain: h * 100,
      payment_id: 0,
      stealth_address: `pollute_${h}`,
      tx_hash: `tx_pollute_${h}`,
      is_miner_tx: true,
      primary_address: "addr1",
      subaddress_index: null,
      serialized: "0".repeat(64),
    });
  }

  console.log(
    "[test 4a] before:",
    fmt(cache),
    "outputs:",
    Object.keys(cache.outputs).length,
  );

  await processScanResultWITHOUT_SIDE_EFFECTS({
    current_range: current,
    result,
    scanCache: cache,
    secret_spend_key: undefined,
  });

  console.log(
    "[test 4a] after:",
    fmt(cache),
    "outputs:",
    Object.keys(cache.outputs).length,
  );
  expect(cache).not.toEqual(initial);

  // only 10 real outputs (151 to 160) should be in cache, not the 9 polluted ones
  expect(Object.keys(cache.outputs).length).toBe(10);
  // none of the polluted outputs should exist
  for (let h = 141; h <= 149; h++) {
    const polluted = Object.values(cache.outputs).find(
      (o) => o.stealth_address === `pollute_${h}`,
    );
    expect(polluted).toBeUndefined();
  }
  console.log("[test 4a] json length:", jsonLen(cache));
});

// 4b: spend pollution from prepended blocks
// TODO: implement this as an integration test
// cant be properly tested as a unit test because it needs to
// have access to a real cache to compute the keyimages

// test("4b: key images from prepended blocks should not overwrite spend info", async () => {
//   const current = makeRange(100, 150);
//   const cache = makeCache(100, 150, "addr1");

//   // pre add an output and its key image to the cache at height 100
//   // below the split height so handleReorg does not remove it
//   const outputId = "1000";
//   cache.outputs[outputId] = {
//     amount: BigInt(100000),
//     block_height: 100,
//     block_timestamp: 1000,
//     index_in_transaction: 0,
//     index_on_blockchain: 1000,
//     payment_id: 0,
//     stealth_address: "stealth_real_100",
//     tx_hash: "tx_real_100",
//     is_miner_tx: true,
//     primary_address: "addr1",
//     subaddress_index: null,
//     serialized: "0".repeat(64),
//   };
//   cache.own_key_images["fake_ki_100"] = outputId;

//   const result = makeResult(150, 155, "addr1", true, 10);
//   // add a fake key image from a prepended block that matches our output
//   result.all_key_images.push({
//     key_image_hex: "fake_ki_100",
//     relative_index: 0,
//     tx_hash: "tx_polluted_spend",
//     block_hash: "pre_hash_0",
//     block_height: 140,
//     block_timestamp: 1000,
//   });

//   console.log("[test 4b] before:", fmt(cache));
//   expect(cache.outputs[outputId].spent_in_tx_hash).toBeUndefined();

//   await processScanResultWITHOUT_SIDE_EFFECTS({
//     current_range: current, result, scanCache: cache, secret_spend_key: undefined,
//   });

//   console.log("[test 4b] after:", fmt(cache));
//   console.log("[test 4b] own_key_images:", Object.keys(cache.own_key_images));
//   console.log("[test 4b] output spent_in_tx_hash:", cache.outputs[outputId]?.spent_in_tx_hash);

//   // the output spend info should NOT be set from the prepended block
//   expect(cache.outputs[outputId].spent_in_tx_hash).toBeUndefined();
//   expect(cache.outputs[outputId].spent_block_height).toBeUndefined();
//   console.log("[test 4b] json length:", jsonLen(cache));
// });
