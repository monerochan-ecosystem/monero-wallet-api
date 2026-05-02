/**
 * unit tests for the reconciler functions that tie the blocks buffer
 * and work item buffer together.
 *
 */
import { test, expect } from "bun:test";
import { type GetBlocksBinBufferItem, type ScanCache } from "../../../dist/api";
import {
  type WorkItem,
  makeWorkItem,
} from "../../../wallet-api/scanning-syncing/scanresult/scanLoop";

import {
  reconcileBlocksBufferChanged,
  reconcileWorkItemDone,
} from "../../../dist/api";

function makeMockBatch(
  local_uuid: string,
  startHeight: number,
  blockCount: number,
): GetBlocksBinBufferItem {
  const block_infos = [];
  for (let i = 0; i < blockCount; i++) {
    block_infos.push({
      block_height: startHeight + i,
      block_hash: `hash_${startHeight + i}`,
      block_timestamp: 1,
    });
  }
  return {
    local_uuid,
    get_blocks_result_meta: {
      new_height: startHeight + blockCount,
      daemon_height: 500,
      status: "OK" as const,
      block_infos,
    },
    data: new Uint8Array(10),
  };
}

function makeMockCache(addr: string): ScanCache {
  return {
    primary_address: addr,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    daemon_height: 0,
  };
}

// -- reconciler 1: blocks buffer changed --

test("reconcileBlocksBufferChanged removes orphaned work items", () => {
  const blocksBuffer: GetBlocksBinBufferItem[] = [];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "orphan-1",
      batch: makeMockBatch("gone-1", 0, 10),
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: false,
    },
    {
      work_uuid: "orphan-2",
      batch: makeMockBatch("gone-2", 10, 10),
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: false,
    },
  ];

  console.log(
    "  before: blocks %d, work items %d",
    blocksBuffer.length,
    workItemBuffer.length,
  );
  console.log(
    "    work uuids: %s",
    workItemBuffer.map((w) => w.work_uuid).join(", "),
  );
  console.log(
    "    work batch uuids: %s",
    workItemBuffer.map((w) => w.batch.local_uuid).join(", "),
  );
  reconcileBlocksBufferChanged(blocksBuffer, workItemBuffer);
  console.log(
    "  after:  blocks %d, work items %d",
    blocksBuffer.length,
    workItemBuffer.length,
  );

  expect(workItemBuffer.length).toBe(0);
});

test("reconcileBlocksBufferChanged keeps work items whose batch is still in blocks buffer", () => {
  const batch = makeMockBatch("keep-me", 0, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "w1",
      batch,
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: false,
    },
  ];

  console.log(
    "  before: blocks %d (uuid: %s), work items %d (batch uuid: %s)",
    blocksBuffer.length,
    blocksBuffer[0].local_uuid,
    workItemBuffer.length,
    workItemBuffer[0].batch.local_uuid,
  );
  reconcileBlocksBufferChanged(blocksBuffer, workItemBuffer);
  console.log(
    "  after:  work items %d, kept uuids: %s",
    workItemBuffer.length,
    workItemBuffer.map((w) => w.work_uuid).join(", "),
  );

  expect(workItemBuffer.length).toBe(1);
  expect(workItemBuffer[0].work_uuid).toBe("w1");
});

test("reconcileBlocksBufferChanged adds work items for unreferenced batches", () => {
  const batch1 = makeMockBatch("new-1", 0, 10);
  const batch2 = makeMockBatch("new-2", 10, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch1, batch2];
  const workItemBuffer: WorkItem[] = [];
  const cache = makeMockCache("addr1");

  console.log(
    "  before: blocks %d (uuids: %s), work items %d",
    blocksBuffer.length,
    blocksBuffer.map((b) => b.local_uuid).join(", "),
    workItemBuffer.length,
  );
  reconcileBlocksBufferChanged(
    blocksBuffer,
    workItemBuffer,
    cache,
    "addr1",
    0,
    10,
  );
  console.log(
    "  after:  work items %d (batch uuids: %s)",
    workItemBuffer.length,
    workItemBuffer.map((w) => w.batch.local_uuid).join(", "),
  );

  expect(workItemBuffer.length).toBe(2);
  expect(workItemBuffer[0].primaryAddress).toBe("addr1");
  expect(workItemBuffer[0].batch.local_uuid).toBe("new-1");
  expect(workItemBuffer[1].batch.local_uuid).toBe("new-2");
});

test("reconcileBlocksBufferChanged does not add work items for already referenced batches", () => {
  const batch = makeMockBatch("refd", 0, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch];
  const existing = {
    work_uuid: "existing",
    batch,
    primaryAddress: "addr1",
    from: 0,
    to: 10,
    scanCache: makeMockCache("addr1"),
    done: false,
  };
  const workItemBuffer: WorkItem[] = [existing];
  const cache = makeMockCache("addr1");

  console.log(
    "  before: blocks %d (uuid: %s), work items %d (batch uuid: %s)",
    blocksBuffer.length,
    blocksBuffer[0].local_uuid,
    workItemBuffer.length,
    workItemBuffer[0].batch.local_uuid,
  );
  reconcileBlocksBufferChanged(
    blocksBuffer,
    workItemBuffer,
    cache,
    "addr1",
    0,
    10,
  );
  console.log(
    "  after:  work items %d (still: %s)",
    workItemBuffer.length,
    workItemBuffer[0].work_uuid,
  );

  expect(workItemBuffer.length).toBe(1);
  expect(workItemBuffer[0].work_uuid).toBe("existing");
});

// -- reconciler 2: work item done --

test("reconcileWorkItemDone shifts done item from left and removes batch from blocks buffer", () => {
  const batch = makeMockBatch("batch-1", 0, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "done-1",
      batch,
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: true,
    },
  ];

  console.log(
    "  before: blocks %d (uuid: %s), work items %d (done: %s)",
    blocksBuffer.length,
    blocksBuffer[0]?.local_uuid,
    workItemBuffer.length,
    workItemBuffer[0].done,
  );
  reconcileWorkItemDone(blocksBuffer, workItemBuffer);
  console.log(
    "  after:  blocks %d, work items %d",
    blocksBuffer.length,
    workItemBuffer.length,
  );

  expect(workItemBuffer.length).toBe(0);
  expect(blocksBuffer.length).toBe(0);
});

test("reconcileWorkItemDone does not shift non-done item", () => {
  const batch = makeMockBatch("batch-1", 0, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "w1",
      batch,
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: false,
    },
  ];

  console.log(
    "  before: blocks %d, work items %d (done: %s)",
    blocksBuffer.length,
    workItemBuffer.length,
    workItemBuffer[0].done,
  );
  reconcileWorkItemDone(blocksBuffer, workItemBuffer);
  console.log(
    "  after:  blocks %d, work items %d (uuid: %s)",
    blocksBuffer.length,
    workItemBuffer.length,
    workItemBuffer[0].work_uuid,
  );

  expect(workItemBuffer.length).toBe(1);
  expect(blocksBuffer.length).toBe(1);
});

test("reconcileWorkItemDone multiple items same batch, keeps batch until last gone", () => {
  const batch = makeMockBatch("shared", 0, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "w1",
      batch,
      primaryAddress: "addr1",
      from: 0,
      to: 5,
      scanCache: makeMockCache("addr1"),
      done: true,
    },
    {
      work_uuid: "w2",
      batch,
      primaryAddress: "addr1",
      from: 5,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: false,
    },
  ];

  console.log(
    "  initial: blocks %d (uuid: %s), work items %d",
    blocksBuffer.length,
    blocksBuffer[0].local_uuid,
    workItemBuffer.length,
  );
  console.log(
    "    w1 done=%s, w2 done=%s",
    workItemBuffer[0].done,
    workItemBuffer[1].done,
  );

  // shift w1, batch should stay (w2 still references it)
  reconcileWorkItemDone(blocksBuffer, workItemBuffer);
  console.log(
    "  after w1 shift: blocks %d, work items %d (uuid: %s)",
    blocksBuffer.length,
    workItemBuffer.length,
    workItemBuffer[0].work_uuid,
  );
  expect(workItemBuffer.length).toBe(1);
  expect(workItemBuffer[0].work_uuid).toBe("w2");
  expect(blocksBuffer.length).toBe(1);

  // mark w2 done and reconcile again
  workItemBuffer[0].done = true;
  console.log("  marking w2 done, reconciling...");
  reconcileWorkItemDone(blocksBuffer, workItemBuffer);
  console.log(
    "  after w2 shift: blocks %d, work items %d",
    blocksBuffer.length,
    workItemBuffer.length,
  );
  expect(workItemBuffer.length).toBe(0);
  expect(blocksBuffer.length).toBe(0);
});

test("reconcileWorkItemDone shifts multiple done items in one call", () => {
  const batch1 = makeMockBatch("b1", 0, 10);
  const batch2 = makeMockBatch("b2", 10, 10);
  const blocksBuffer: GetBlocksBinBufferItem[] = [batch1, batch2];
  const workItemBuffer: WorkItem[] = [
    {
      work_uuid: "w1",
      batch: batch1,
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: true,
    },
    {
      work_uuid: "w2",
      batch: batch2,
      primaryAddress: "addr1",
      from: 0,
      to: 10,
      scanCache: makeMockCache("addr1"),
      done: true,
    },
  ];

  console.log(
    "  before: blocks %d (%s), work items %d (%s)",
    blocksBuffer.length,
    blocksBuffer.map((b) => b.local_uuid).join(", "),
    workItemBuffer.length,
    workItemBuffer.map((w) => `${w.work_uuid}(done=${w.done})`).join(", "),
  );
  reconcileWorkItemDone(blocksBuffer, workItemBuffer);
  console.log(
    "  after:  blocks %d, work items %d",
    blocksBuffer.length,
    workItemBuffer.length,
  );

  expect(workItemBuffer.length).toBe(0);
  expect(blocksBuffer.length).toBe(0);
});
