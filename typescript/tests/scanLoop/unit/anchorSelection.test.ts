/**
 * unit tests for selectAnchors helper.
 *
 * selectAnchors builds a CacheRange from block_infos given the wallet's
 * tip index. it must work regardless of where the tip sits in the array.
 *
 * semantic roles of block_hashes:
 *   block_hashes[0] is the tip, newest scanned block in this range
 *   block_hashes[1] is the candidate anchor, ~100 blocks before tip
 *   block_hashes[2] is the anchor, ~200 blocks before tip or carried from old range
 *
 * properties verified by these tests:
 *   start equals tip height, end equals block at endIndex
 *   block_hashes has exactly 3 elements
 *   anchors move forward as scan grows over batches
 *   anchors are replaced when anchor becomes >200 blocks old
 *   works with random tip offsets in large batches
 *   works when scanning a subset of the batch via endIndex
 */
import { test, expect } from "bun:test";
import { selectAnchors, findTipIndex } from "../../../dist/api";
import type { BlockInfo, CacheRange } from "../../../dist/api";

function bi(height: number, hash?: string): BlockInfo {
  return {
    block_height: height,
    block_hash: hash ?? `hash_${height}`,
    block_timestamp: 1000,
  };
}

function makeBlockInfos(start: number, count: number): BlockInfo[] {
  const infos: BlockInfo[] = [];
  for (let i = 0; i < count; i++) infos.push(bi(start + i));
  return infos;
}

// prepend mock blocks before the real blocks
type Prepend = { count: number; startHeight: number };
function makeBlockInfosWithPrepend(
  realStart: number,
  realCount: number,
  prepend: Prepend,
): BlockInfo[] {
  const infos: BlockInfo[] = [];
  for (let i = 0; i < prepend.count; i++) {
    infos.push(bi(prepend.startHeight + i, `pre_${i}`));
  }
  for (let i = 0; i < realCount; i++) {
    infos.push(bi(realStart + i));
  }
  return infos;
}

// 1: basic shape with tip at start of batch

test("1: tip at index 0, range shape is correct", () => {
  const infos = makeBlockInfos(100, 50);
  const oldRange: CacheRange = {
    start: 80,
    end: 100,
    block_hashes: [bi(100), bi(90), bi(80)],
  };

  const result = selectAnchors(infos, 0, oldRange);

  console.log("[test 1] start:", result.start, "end:", result.end);
  console.log(
    "[test 1] hashes:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(100);
  expect(result.end).toBe(149);
  expect(result.block_hashes.length).toBe(3);
  expect(result.block_hashes[0].block_height).toBe(149);
  // anchor heights must be <= tip height
  expect(result.block_hashes[1].block_height).toBeLessThanOrEqual(149);
  expect(result.block_hashes[2].block_height).toBeLessThanOrEqual(149);
});

// 2: tip in middle of batch with prepended blocks

test("2: tip at index 10 with prepended blocks, range shape is correct", () => {
  const infos = makeBlockInfosWithPrepend(100, 20, {
    count: 10,
    startHeight: 90,
  });
  const oldRange: CacheRange = {
    start: 80,
    end: 100,
    block_hashes: [bi(100), bi(90), bi(80)],
  };

  const result = selectAnchors(infos, 10, oldRange);

  console.log("[test 2] start:", result.start, "end:", result.end);
  console.log(
    "[test 2] hashes:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(100);
  expect(result.end).toBe(119);
  expect(result.block_hashes.length).toBe(3);
  expect(result.block_hashes[0].block_height).toBe(119);
  expect(result.block_hashes[1].block_height).toBeLessThanOrEqual(119);
  expect(result.block_hashes[2].block_height).toBeLessThanOrEqual(119);
});

// 3: tip near end of large batch

test("3: tip at index 900 of 1000 blocks, anchors spread out", () => {
  const infos = makeBlockInfos(0, 1000);
  const oldRange: CacheRange = {
    start: 800,
    end: 900,
    block_hashes: [bi(900), bi(850), bi(800)],
  };

  const result = selectAnchors(infos, 900, oldRange);

  console.log("[test 3] start:", result.start, "end:", result.end);
  console.log(
    "[test 3] hashes:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(900);
  expect(result.end).toBe(999);
  expect(result.block_hashes[0].block_height).toBe(999);

  const tip = result.block_hashes[0].block_height;
  const cand = result.block_hashes[1].block_height;
  const anchor = result.block_hashes[2].block_height;

  // candidate should be reasonably before tip
  expect(tip - cand).toBeGreaterThanOrEqual(0);
  // anchor should be at or before candidate
  expect(cand - anchor).toBeGreaterThanOrEqual(0);
});

// 4: simulate scan growth over 10 batches, anchors move

test("4: anchors move forward as scan grows over multiple batches", () => {
  let currentRange: CacheRange = {
    start: 0,
    end: 0,
    block_hashes: [bi(0), bi(0), bi(0)],
  };

  const anchorHistory: number[][] = [];

  for (let batch = 0; batch < 10; batch++) {
    const batchStart = batch * 100;
    const infos = makeBlockInfos(batchStart, 100);
    const tipIndex = 0; // each batch starts where previous ended

    currentRange = selectAnchors(infos, tipIndex, currentRange);
    anchorHistory.push(currentRange.block_hashes.map((h) => h.block_height));
  }

  console.log("[test 4] anchor history (tip, candidate, anchor):");
  for (const [tip, cand, anchor] of anchorHistory) {
    console.log(`  tip=${tip} candidate=${cand} anchor=${anchor}`);
  }

  // anchors should generally move forward, not stay at 0 forever
  const lastAnchor = anchorHistory[anchorHistory.length - 1][2];
  expect(lastAnchor).toBeGreaterThan(anchorHistory[0][2]);

  // tip should always be >= candidate >= anchor
  for (const [tip, cand, anchor] of anchorHistory) {
    expect(tip).toBeGreaterThanOrEqual(cand);
    expect(cand).toBeGreaterThanOrEqual(anchor);
  }
});

// 5: random tip offsets in large batch with realistic oldRanges

test("5: random tip offsets in 5000 block batch, all valid", () => {
  const infos = makeBlockInfos(0, 5000);

  // realistic oldRanges for a wallet that scanned up to each tipIndex
  const scenarios: { tipIndex: number; oldRange: CacheRange }[] = [
    {
      tipIndex: 0,
      oldRange: { start: 0, end: 0, block_hashes: [bi(0), bi(0), bi(0)] },
    },
    {
      tipIndex: 50,
      oldRange: { start: 0, end: 50, block_hashes: [bi(50), bi(0), bi(0)] },
    },
    {
      tipIndex: 500,
      oldRange: {
        start: 400,
        end: 500,
        block_hashes: [bi(500), bi(400), bi(300)],
      },
    },
    {
      tipIndex: 2500,
      oldRange: {
        start: 2300,
        end: 2500,
        block_hashes: [bi(2500), bi(2400), bi(2200)],
      },
    },
    {
      tipIndex: 4999,
      oldRange: {
        start: 4899,
        end: 4999,
        block_hashes: [bi(4999), bi(4949), bi(4899)],
      },
    },
  ];

  for (const { tipIndex, oldRange } of scenarios) {
    const result = selectAnchors(infos, tipIndex, oldRange);

    console.log(
      `[test 5] tipIndex=${tipIndex}:`,
      result.block_hashes.map((h) => h.block_height),
    );

    expect(result.start).toBe(tipIndex);
    expect(result.end).toBe(4999);
    expect(result.block_hashes.length).toBe(3);

    const [tip, cand, anchor] = result.block_hashes.map((h) => h.block_height);
    expect(tip).toBe(4999);
    expect(cand).toBeLessThanOrEqual(tip);
    expect(anchor).toBeLessThanOrEqual(cand);
    // no negative heights
    expect(anchor).toBeGreaterThanOrEqual(0);
  }
});

// 6: old anchor gets replaced when it becomes too old

test("6: old anchor replaced after growing beyond 200 blocks", () => {
  // start with a small range
  let currentRange: CacheRange = {
    start: 0,
    end: 100,
    block_hashes: [bi(100), bi(50), bi(0)],
  };

  // grow by 300 blocks in one batch
  const infos = makeBlockInfos(100, 300);
  const result = selectAnchors(infos, 0, currentRange);

  console.log("[test 6] before: tip=100 candidate=50 anchor=0");
  console.log(
    "[test 6] after:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(100);
  expect(result.end).toBe(399);

  const [tip, cand, anchor] = result.block_hashes.map((h) => h.block_height);
  // old anchor was at 0, now 300 blocks behind tip. should be replaced.
  // new anchor should be the old candidate (50)
  expect(anchor).toBe(50);
});

// 7: small batch with no room for 100-back candidate

test("7: small batch of 5 blocks, candidate stays within bounds", () => {
  const infos = makeBlockInfos(100, 5);
  const oldRange: CacheRange = {
    start: 95,
    end: 100,
    block_hashes: [bi(100), bi(98), bi(95)],
  };

  const result = selectAnchors(infos, 0, oldRange);

  console.log(
    "[test 7] hashes:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(100);
  expect(result.end).toBe(104);
  expect(result.block_hashes.length).toBe(3);

  // tip >= candidate >= anchor, all valid BlockInfo
  const tip = result.block_hashes[0].block_height;
  const cand = result.block_hashes[1].block_height;
  const anchor = result.block_hashes[2].block_height;
  expect(tip).toBeGreaterThanOrEqual(cand);
  expect(cand).toBeGreaterThanOrEqual(anchor);
});

// 8: scan subset of batch using endIndex

test("8: scan from index 101 to 142 in 1000 block batch", () => {
  const infos = makeBlockInfos(0, 1000);
  const oldRange: CacheRange = {
    start: 50,
    end: 100,
    block_hashes: [bi(100), bi(75), bi(50)],
  };

  const result = selectAnchors(infos, 101, oldRange, 142);

  console.log("[test 8] start:", result.start, "end:", result.end);
  console.log(
    "[test 8] hashes:",
    result.block_hashes.map((h) => h.block_height),
  );

  expect(result.start).toBe(101);
  expect(result.end).toBe(142);
  expect(result.block_hashes[0].block_height).toBe(142);
  expect(result.block_hashes[1].block_height).toBeLessThanOrEqual(142);
  expect(result.block_hashes[2].block_height).toBeLessThanOrEqual(
    result.block_hashes[1].block_height,
  );
  // old anchor at 50 should NOT be replaced since 142 - 50 = 92 < 200
  expect(result.block_hashes[2].block_height).toBe(50);
});

// findTipIndex tests

// 9: tip found at index 0

test("9: findTipIndex finds hash at index 0", () => {
  const infos = makeBlockInfos(100, 50);
  const oldTip = bi(100);

  const result = findTipIndex(infos, oldTip);

  console.log("[test 9] result:", result);
  expect(result).toBe(0);
});

// 10: tip found at index 10 with prepended blocks

test("10: findTipIndex finds hash at index 10 with prepended blocks", () => {
  const infos = makeBlockInfosWithPrepend(100, 20, { count: 10, startHeight: 90 });
  const oldTip = bi(100);

  const result = findTipIndex(infos, oldTip);

  console.log("[test 10] result:", result);
  expect(result).toBe(10);
});

// 11: tip found at last index

test("11: findTipIndex finds hash at last index", () => {
  const infos = makeBlockInfos(0, 100);
  const oldTip = bi(99);

  const result = findTipIndex(infos, oldTip);

  console.log("[test 11] result:", result);
  expect(result).toBe(99);
});

// 12: hash not found returns reorg_found

test("12: findTipIndex returns reorg_found when hash not in array", () => {
  const infos = makeBlockInfos(100, 50);
  const oldTip = bi(999, "hash_does_not_exist");

  const result = findTipIndex(infos, oldTip);

  console.log("[test 12] result:", result);
  expect(result).toBe("reorg_found");
});

// 13: empty block_infos returns empty_blocks_array

test("13: findTipIndex returns empty_blocks_array on empty block_infos", () => {
  const oldTip = bi(100);

  const result = findTipIndex([], oldTip);

  console.log("[test 13] result:", result);
  expect(result).toBe("empty_blocks_array");
});
