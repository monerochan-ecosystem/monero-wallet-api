/**
 * scanCoordination.test.ts, integration for findWorkToBeDone
 * + setupBlocksBufferGenerator pipeline.
 *
 * findWorkToBeDone reads ScanSettings, reads wallet keys from env,
 * calls initScanCache to create/update cache files, then determines
 * the anchor range (lowest end among wallets that cover the start height).
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
import { makeTestKeyPair } from "../../../wallet-api/keypairs-seeds/keypairs";

const OUT = "test-data/scanCoordination";
const MONEROD = "tests/moneronode/monerod";
const PORT = 18092;
const URL = `http://127.0.0.1:${PORT}`;

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

// advance generator until first sync event
async function advance(g: any, path: string) {
  while (true) {
    const { value, done } = await g.next();
    if (done) return;
    if (value === "blocks_buffer_changed") continue;
    await handleConnectionStatusChanges(value, path);
    if ("scanned_ranges" in value) return;
  }
}

// generate a keypair and set env vars so walletSettingsPlusKeys can find them
interface KeypairResult {
  addr: string;
  vk: string;
  sk: string;
}
async function makeKeypair(): Promise<KeypairResult> {
  const kp = await makeTestKeyPair();
  const a = kp.view_key.mainnet_primary;
  const v = kp.view_key.view_key;
  const s = kp.spend_key;
  Bun.env[`vk${a}`] = v;
  Bun.env[`sk${a}`] = s;
  return { addr: a, vk: v, sk: s };
}

let kp1: KeypairResult, kp2: KeypairResult;

beforeAll(async () => {
  await waitNode();
  const addr = JSON.parse(
    await Bun.file("tests/moneronode/keypairs.json").text(),
  )[0].view_key.mainnet_primary;
  await rpc("generateblocks", { amount_of_blocks: 200, wallet_address: addr });
  kp1 = await makeKeypair();
  kp2 = await makeKeypair();
}, 30000);

test("a: two wallets, findWorkToBeDone creates caches and picks anchor", async () => {
  const dir = `${OUT}/a`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }, { primary_address: kp2.addr }],
      node_url: URL,
      start_height: null,
    },
    `${dir}/ScanSettings.json`,
  );

  const w = await findWorkToBeDone(`${dir}/ScanSettings.json`, `${dir}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.wallet_caches.length).toBe(2);
  expect(w.anchor_range).toBeDefined();
  expect(w.start_height).toBeGreaterThan(0);
  console.log(
    `[a] wallets: 2, anchor: ${w.anchor_range?.start}-${w.anchor_range?.end}, start: ${w.start_height}`,
  );
});

test("b: single wallet with generator pipeline", async () => {
  const dir = `${OUT}/b`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: null,
    },
    `${dir}/ScanSettings.json`,
  );

  let w = await findWorkToBeDone(`${dir}/ScanSettings.json`, `${dir}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.wallet_caches.length).toBe(1);
  expect(w.anchor_range).toBeDefined();
  console.log(
    `[b] first call: anchor ${w.anchor_range?.start}-${w.anchor_range?.end}, start ${w.start_height}`,
  );

  // second call with start_height below tip to test pipeline
  const t = await (
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
  const h150 = t?.result?.block_header?.hash;

  // write cache that initScanCache will merge into
  await Bun.write(
    `${dir}/${kp1.addr}_cache.json`,
    JSON.stringify(
      {
        daemon_height: 0,
        outputs: {},
        own_key_images: {},
        scanned_ranges: [
          {
            start: 0,
            end: 150,
            block_hashes: [
              { block_height: 150, block_hash: h150, block_timestamp: 1 },
              {
                block_height: 0,
                block_hash:
                  "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3",
                block_timestamp: 1,
              },
              {
                block_height: 0,
                block_hash:
                  "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3",
                block_timestamp: 1,
              },
            ],
          },
        ],
        primary_address: kp1.addr,
      },
      null,
      2,
    ),
  );

  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 150,
    },
    `${dir}/ScanSettings.json`,
  );

  w = await findWorkToBeDone(`${dir}/ScanSettings.json`, `${dir}/`);
  expect(w).not.toBe(false);
  if (!w) return;

  const { generator, blocksBuffer } = await setupBlocksBufferGenerator({
    nodeUrl: URL,
    startHeight: w.start_height,
    anchor_range: w.anchor_range,
    scanSettingsPath: `${dir}/ScanSettings.json`,
  });
  await advance(generator, `${dir}/ScanSettings.json`);

  expect(blocksBuffer.length).toBeGreaterThan(0);
  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(`${dir}/ScanSettings.json`)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
  console.log(
    `[b] pipeline: buffer ${blocksBuffer.length}, status ${cs.last_packet.status}`,
  );
});

test("c: no wallets in ScanSettings, returns false", async () => {
  const dir = `${OUT}/c`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  await writeScanSettings(
    { wallets: [], node_url: URL, start_height: null },
    `${dir}/ScanSettings.json`,
  );
  const w = await findWorkToBeDone(`${dir}/ScanSettings.json`, `${dir}/`);
  expect(w).toBe(false);
});

test("d: full pipeline with real blocks", async () => {
  const dir = `${OUT}/d`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const t = await (
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
  const h150 = t?.result?.block_header?.hash;

  await Bun.write(
    `${dir}/${kp1.addr}_cache.json`,
    JSON.stringify(
      {
        daemon_height: 0,
        outputs: {},
        own_key_images: {},
        scanned_ranges: [
          {
            start: 0,
            end: 150,
            block_hashes: [
              { block_height: 150, block_hash: h150, block_timestamp: 1 },
              {
                block_height: 0,
                block_hash:
                  "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3",
                block_timestamp: 1,
              },
              {
                block_height: 0,
                block_hash:
                  "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3",
                block_timestamp: 1,
              },
            ],
          },
        ],
        primary_address: kp1.addr,
      },
      null,
      2,
    ),
  );

  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 150,
    },
    `${dir}/ScanSettings.json`,
  );

  const w = await findWorkToBeDone(`${dir}/ScanSettings.json`, `${dir}/`);
  expect(w).not.toBe(false);
  if (!w) return;
  expect(w.anchor_range?.end).toBe(150);
  expect(w.start_height).toBe(150);

  const { generator, blocksBuffer } = await setupBlocksBufferGenerator({
    nodeUrl: URL,
    startHeight: w.start_height,
    anchor_range: w.anchor_range,
    scanSettingsPath: `${dir}/ScanSettings.json`,
  });
  await advance(generator, `${dir}/ScanSettings.json`);

  expect(blocksBuffer.length).toBeGreaterThan(0);
  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(`${dir}/ScanSettings.json`)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
});

afterAll(() => {
  proc.kill(9);
  try {
    proc.exited;
  } catch {}
});
