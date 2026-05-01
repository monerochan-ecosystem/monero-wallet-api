/**
 * scanCoordination.test.ts, integration for findWorkToBeDone
 * + setupBlocksBufferGenerator pipeline.
 *
 * all wallet cache ranges must cover the node's tip height, not exceed it.
 * (too large start_height culling is done by findWorkToBeDone)
 * anchor is the cached range ending lowest among those that do.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  findWorkToBeDone,
  setupBlocksBufferGenerator,
  handleConnectionStatusChanges,
  writeScanSettings,
  connectionStatusFilePath,
} from "../../../dist/api";

const OUT = "test-data/scanCoordination";
const MONEROD = "tests/moneronode/monerod";
const KEYPAIRS = "tests/moneronode/keypairs.json";
const PORT = 18092;
const URL = `http://127.0.0.1:${PORT}`;

const A =
  "45djNCPuMDuVYrekuBqhkLi24YA6RpVrG9Wh1meEJWf6RTpXkgnuRkLfmRBs66X1GTJc11BnWgUvWREEbyMWwp1pRLUCPye";
const B =
  "43BfNNFey6KbDr8F8MqEviY5RjbzWTMbbeuJvo8EX4gYf2zcGqi3Y9B2jBUpRYjyRWNJ9iyV7vK1hiEzdhMXpniSGFHNt7p";
const C =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";

const proc = Bun.spawn(
  [
    MONEROD,
    "--regtest",
    "--offline",
    "--fixed-difficulty",
    "1",
    "--rpc-bind-ip",
    "127.0.0.1",
    "--rpc-bind-port",
    String(PORT),
    "--non-interactive",
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

async function waitNode() {
  const dl = Date.now() + 30000;
  while (Date.now() < dl) {
    try {
      const r = await fetch(`${URL}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      });
      if (r.ok && (await r.json()).result?.height) break;
    } catch {}
    await Bun.sleep(500);
  }
}

async function rpc(method: string, params: any) {
  await fetch(`${URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
}

async function tip(): Promise<number> {
  const r = await (
    await fetch(`${URL}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
    })
  ).json();
  return (r?.result?.height ?? 1) - 1;
}

function range(start: number, end: number, hash: string) {
  const fill =
    hash || "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3";
  return {
    start,
    end,
    block_hashes: [
      { block_height: end, block_hash: hash, block_timestamp: 1 },
      { block_height: start, block_hash: fill, block_timestamp: 1 },
      { block_height: start, block_hash: fill, block_timestamp: 1 },
    ],
  };
}

async function cache(addr: string, ranges: any[]) {
  await Bun.write(
    `${OUT}/${addr}_cache.json`,
    JSON.stringify(
      {
        daemon_height: 0,
        outputs: {},
        own_key_images: {},
        scanned_ranges: ranges,
        primary_address: addr,
      },
      null,
      2,
    ),
  );
}

async function advance(g: any, path: string) {
  while (true) {
    const { value, done } = await g.next();
    if (done) return;
    if (value === "blocks_buffer_changed") continue;
    await handleConnectionStatusChanges(value, path);
    if ("scanned_ranges" in value) return;
  }
}

await rm(OUT, { force: true, recursive: true }).catch(() => {});

beforeAll(async () => {
  await waitNode();
  const kp = JSON.parse(await Bun.file(KEYPAIRS).text());
  await rpc("generateblocks", {
    amount_of_blocks: 200,
    wallet_address: kp[0].view_key.mainnet_primary,
  });
}, 30000);

test("a: two wallets, both cover tip, lower end wins", async () => {
  const t = await tip();
  // A: 0-250, B: 20-210.  both cover t=200.  lowest end is B (210)
  await cache(A, [range(0, 250, "a")]);
  await cache(B, [range(20, 210, "b")]);
  await writeScanSettings(
    {
      wallets: [{ primary_address: A }, { primary_address: B }],
      node_url: URL,
      start_height: null,
    },
    `${OUT}/ScanSettings.json`,
  );

  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range?.start).toBe(20);
  expect(w.anchor_range?.end).toBe(210);
  expect(w.start_height).toBe(210);
  expect(w.wallet_caches.length).toBe(2);
});

test("b: one wallet missing cache, uses remaining", async () => {
  await rm(`${OUT}/${B}_cache.json`, { force: true }).catch(() => {});
  // only A has a cache now
  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range).toBeDefined();
  expect(w.wallet_caches.length).toBe(1);
});

test("c: no cache files, anchor_range undefined", async () => {
  await rm(`${OUT}/${A}_cache.json`, { force: true }).catch(() => {});
  await rm(`${OUT}/${B}_cache.json`, { force: true }).catch(() => {});
  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range).toBeUndefined();
  expect(w.wallet_caches.length).toBe(0);
});

test("d: single block range at node tip", async () => {
  const t = await tip();
  await cache(A, [range(t, t, "d")]);
  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range?.start).toBe(t);
  expect(w.anchor_range?.end).toBe(t);
  expect(w.start_height).toBe(t);
});

test("e: three wallets, lowest end among covers wins", async () => {
  const t = await tip();
  await cache(A, [range(0, t + 50, "e1")]);
  await cache(B, [range(20, t + 10, "e2")]);
  await cache(C, [range(10, t + 30, "e3")]);
  await writeScanSettings(
    {
      wallets: [
        { primary_address: A },
        { primary_address: B },
        { primary_address: C },
      ],
      node_url: URL,
      start_height: null,
    },
    `${OUT}/ScanSettings.json`,
  );

  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  // B's end is lowest (t+10)
  expect(w.anchor_range?.start).toBe(20);
  expect(w.anchor_range?.end).toBe(t + 10);
  expect(w.start_height).toBe(t + 10);
});

test("f: full pipeline with real blocks", async () => {
  const t = await tip();
  const h = await (
    await fetch(`${URL}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "0",
        method: "get_block_header_by_height",
        params: { height: 150 },
      }),
    })
  ).json();
  const h150 = h?.result?.block_header?.hash;

  // wallet cache scanned 0-150 with real hash
  await cache(A, [range(0, 150, h150)]);
  await writeScanSettings(
    {
      wallets: [{ primary_address: A }],
      node_url: URL,
      start_height: 150,
    },
    `${OUT}/ScanSettings.json`,
  );

  const w = await findWorkToBeDone(`${OUT}/ScanSettings.json`, `${OUT}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range?.end).toBe(150);
  expect(w.start_height).toBe(150);

  // generator with anchor (0,150) node has blocks up to 200, fetches 151+
  const { generator, blocksBuffer } = await setupBlocksBufferGenerator({
    nodeUrl: URL,
    startHeight: w.start_height,
    anchor_range: w.anchor_range,
    scanSettingsPath: `${OUT}/ScanSettings.json`,
  });
  await advance(generator, `${OUT}/ScanSettings.json`);

  expect(blocksBuffer.length).toBeGreaterThan(0);
  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(`${OUT}/ScanSettings.json`)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
});

afterAll(() => {
  proc.kill(9);
  try {
    proc.exited;
  } catch {}
});
