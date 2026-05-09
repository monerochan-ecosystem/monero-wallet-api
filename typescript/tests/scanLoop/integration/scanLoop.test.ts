import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  coordinatorMain,
  writeScanSettings,
  connectionStatusFilePath,
  readCacheFileDefaultLocation,
  NodeUrl,
  ViewPair,
  signTransaction,
  type Output,
  type ScanCache,
  CatastrophicReorgError,
  type CoordinatorEvent,
} from "../../../dist/api";

import { makeTestKeyPair } from "../../../wallet-api/keypairs-seeds/keypairs";

const OUT = "test-data/scanLoop";
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
  const resp = await fetch(`${URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
  if (!resp.ok) throw new Error(`rpc ${method} failed: ${resp.statusText}`);
  return await resp.json();
}

interface KeypairResult {
  addr: string;
  vk: string;
  sk: string;
}
async function makeKeypair(): Promise<KeypairResult> {
  const kp = await makeTestKeyPair();
  const a = kp.view_key.mainnet_primary;
  Bun.env[`vk${a}`] = kp.view_key.view_key;
  Bun.env[`sk${a}`] = kp.spend_key;
  return { addr: a, vk: kp.view_key.view_key, sk: kp.spend_key };
}

let kp1: KeypairResult;

beforeAll(async () => {
  await Bun.$`pgrep monerod && kill -9 $(pgrep monerod) 2>/dev/null; echo "monerod processes remaining: $(pgrep monerod | wc -l)"`;
  const proc2 = Bun.spawn(
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
  await Bun.sleep(500);
  await waitNode();

  await rpc("generateblocks", {
    amount_of_blocks: 200,
    wallet_address: (await makeKeypair()).addr,
  });
  kp1 = await makeKeypair();
  await rpc("generateblocks", {
    amount_of_blocks: 10,
    wallet_address: kp1.addr,
  });
}, 30000);

async function setupContext(dir: string, addr: string) {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const scanSettingsPath = `${dir}/ScanSettings.json`;
  await writeScanSettings(
    { wallets: [{ primary_address: addr }], node_url: URL, start_height: 0 },
    scanSettingsPath,
  );
  return { scanSettingsPath };
}

async function waitForScanReady(
  gen: AsyncGenerator<CoordinatorEvent>,
): Promise<boolean> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return false;
    if (value.type === "scan_ready") return true;
  }
}

async function waitForScanReadyAll(
  gen: AsyncGenerator<CoordinatorEvent>,
  wallets: string[],
): Promise<boolean> {
  const remaining = new Set(wallets);
  while (remaining.size > 0) {
    const { value, done } = await gen.next();
    if (done) return false;
    if (value.type === "scan_ready") {
      remaining.delete(value.address);
    }
  }
  return true;
}

function selectInputsForTx(cache: ScanCache, targetAmount: bigint): Output[] {
  const daemonHeight = cache.daemon_height || 1000000;
  const spendable = (Object.values(cache.outputs) as Output[])
    .filter((o) => {
      if (o.burned || o.spent_in_tx_hash) return false;
      const unlock = o.is_miner_tx ? o.block_height + 60 : o.block_height + 10;
      return unlock <= daemonHeight;
    })
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const selected: Output[] = [];
  let total = 0n;
  for (const o of spendable) {
    selected.push(o);
    total += o.amount;
    if (total >= targetAmount) break;
  }
  return selected;
}

async function prepareAndMakeInputs(
  node: any,
  selectedInputs: Output[],
  sampleCount: number,
): Promise<any[]> {
  const dist = await node.getOutputDistribution();
  const inputs: any[] = [];
  for (const output of selectedInputs) {
    const decoys = node.sampleDecoys(
      output.index_on_blockchain,
      dist,
      sampleCount,
    );
    const outs = await node.getOutsBin(decoys.candidates);
    inputs.push(node.makeInput(output, decoys.candidates, outs));
  }
  return inputs;
}

async function makeAndSendTx(
  viewpair: any,
  node: any,
  cache: ScanCache,
  spendKey: string,
  destAddr: string,
  amount: string,
  sampleCount?: number,
): Promise<any> {
  const feeEstimate = await node.getFeeEstimate();
  const feePerByte = BigInt(feeEstimate.fees![0]);
  const totalNeeded = BigInt(amount) + feePerByte * 10000n;
  const selected = selectInputsForTx(cache, totalNeeded);
  if (selected.length === 0) throw new Error("no spendable inputs");
  const inputs = await prepareAndMakeInputs(node, selected, sampleCount ?? 100);
  const unsignedTx = viewpair.makeTransaction({
    inputs,
    payments: [{ address: destAddr, amount }],
    fee_response: feeEstimate,
    fee_priority: "unimportant",
  });
  const signedTx = await signTransaction(unsignedTx, spendKey);
  return await node.sendRawTransaction(signedTx);
}

test("a: basic scan through coordinator", async () => {
  const dir = `${OUT}/a`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
  const ctx = await setupContext(dir, kp1.addr);

  const gen = coordinatorMain(ctx.scanSettingsPath, `${dir}/`);
  for await (const event of gen) {
    if (
      event.type === "scan_ready" &&
      event.result.result?.new_height === 210
    ) {
      console.log("[test a] scan ready", event.result.result?.new_height);
      break;
    }
  }

  const updatedCache = await readCacheFileDefaultLocation(kp1.addr, dir);
  expect(updatedCache).toBeDefined();
  if (!updatedCache) throw new Error("updatedCache missing");
  expect(Object.keys(updatedCache.outputs).length).toBeGreaterThan(0);
  const lr = updatedCache.scanned_ranges?.at(-1);
  expect(lr).toBeDefined();
  expect(lr!.end).toBeGreaterThan(150);

  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(ctx.scanSettingsPath)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
}, 30000);

test("b: reorg mid-scan clears work buffer and rescan", async () => {
  const dir = `${OUT}/b`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
  const ctx = await setupContext(dir, kp1.addr);

  // Phase 1: first scan through coordinator
  const gen = coordinatorMain(ctx.scanSettingsPath, `${dir}/`);
  const phase1Ok = await waitForScanReady(gen);
  expect(phase1Ok).toBe(true);
  console.log("[test b] first scan done");

  // Phase 2: reorg by pop blocks, generate new ones
  const popResult = await (
    await fetch(`${URL}/pop_blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nblocks: 2 }),
    })
  ).json();
  console.log("[test b] pop_blocks result:", JSON.stringify(popResult));
  const genResult = await rpc("generateblocks", {
    amount_of_blocks: 3,
    wallet_address: kp1.addr,
  });
  console.log("[test b] generateblocks result:", JSON.stringify(genResult));

  // Phase 3: continue coordinator, it will detect reorg and rescan
  const phase3Ok = await waitForScanReady(gen);
  expect(phase3Ok).toBe(true);
  console.log("[test b] second scan done");

  const finalCache = await readCacheFileDefaultLocation(kp1.addr, dir);
  expect(finalCache).toBeDefined();
  if (!finalCache) throw new Error("finalCache missing");
  console.log(
    "  test b finalCache: range=",
    JSON.stringify(
      finalCache.scanned_ranges?.map((r: any) => [r.start, r.end]),
    ),
    "bh0=",
    finalCache.scanned_ranges?.[0]?.block_hashes?.[0]?.block_height,
    "outputs=",
    Object.keys(finalCache.outputs).length,
  );
  // verifies reorg was detected with split_heights
  expect(finalCache.reorg_info).toBeDefined();
  if (!finalCache.reorg_info) throw new Error("reorg_info missing after reorg");
  expect(finalCache.reorg_info.split_heights).toBeDefined();
  expect(finalCache.reorg_info.split_heights.length).toBeGreaterThan(0);
  expect(typeof finalCache.reorg_info.split_heights[0].block_height).toBe(
    "number",
  );
  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(ctx.scanSettingsPath)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
}, 20000);

test("c: reorg after tx between wallets detects removed_outputs and reverted_spends", async () => {
  const dir = `${OUT}/c`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
  const kp2 = await makeKeypair();

  await rpc("generateblocks", {
    amount_of_blocks: 200,
    wallet_address: kp1.addr,
  });

  const scanSettingsPath = `${dir}/ScanSettings.json`;
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }, { primary_address: kp2.addr }],
      node_url: URL,
      start_height: 150,
    },
    scanSettingsPath,
  );

  const wallets = [kp1.addr, kp2.addr];

  // Phase 1: initial scan via coordinator
  const gen = coordinatorMain(scanSettingsPath, `${dir}/`);
  const phase1Ok = await waitForScanReadyAll(gen, wallets);
  expect(phase1Ok).toBe(true);
  console.log("[test c] initial scan done");

  let cache0 = await readCacheFileDefaultLocation(kp1.addr, dir);
  expect(cache0).toBeDefined();
  if (!cache0) throw new Error("kp1 cache missing");
  expect(Object.keys(cache0.outputs).length).toBeGreaterThan(0);
  console.log(
    `  kp1 has ${Object.keys(cache0.outputs).length} outputs before tx`,
  );

  // Phase 2: send tx, mine block
  const viewpair = await ViewPair.create(kp1.addr, kp1.vk, 0);
  const node = await NodeUrl.create(URL);
  const sendResult = await makeAndSendTx(
    viewpair,
    node,
    cache0,
    kp1.sk,
    kp2.addr,
    "100000000000",
  );
  console.log("  send result:", JSON.stringify(sendResult));
  expect(sendResult.status).toBe("OK");

  await rpc("generateblocks", {
    amount_of_blocks: 1,
    wallet_address: kp1.addr,
  });

  // Phase 3: post-tx scan
  const phase3Ok = await waitForScanReadyAll(gen, wallets);
  expect(phase3Ok).toBe(true);
  console.log("[test c] post-tx scan done");

  // Phase 4: pop blocks to make reorg, generate different chain
  await fetch(`${URL}/pop_blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nblocks: 10 }),
  });
  await rpc("generateblocks", {
    amount_of_blocks: 10,
    wallet_address: kp2.addr,
  });

  // Phase 5: post-reorg scan
  const phase5Ok = await waitForScanReadyAll(gen, wallets);
  expect(phase5Ok).toBe(true);
  console.log("[test c] post-reorg scan done");

  // Phase 6: assertions
  cache0 = await readCacheFileDefaultLocation(kp1.addr, dir);
  if (!cache0) throw new Error("kp1 cache missing");
  console.log(
    "  kp1 reorg_info:",
    JSON.stringify(cache0.reorg_info, (_k: any, v: any) =>
      typeof v === "bigint" ? v.toString() : v,
    )?.slice(0, 200),
  );
  expect(cache0.reorg_info).toBeDefined();
  if (!cache0.reorg_info) throw new Error("kp1 reorg_info missing");
  expect(cache0.reorg_info.reverted_spends).toBeDefined();
  expect(cache0.reorg_info.reverted_spends.length).toBeGreaterThan(0);

  const cache2 = await readCacheFileDefaultLocation(kp2.addr, dir);
  if (!cache2) throw new Error("kp2 cache missing");
  console.log(
    "  kp2 post-rescan: outputs=",
    Object.keys(cache2.outputs).length,
    "reorg_info=",
    JSON.stringify(cache2.reorg_info, (_k: any, v: any) =>
      typeof v === "bigint" ? v.toString() : v,
    )?.slice(0, 300),
  );
  // dont touch, verifies removed outputs after reorg
  expect(cache2.reorg_info).toBeDefined();
  if (!cache2.reorg_info) throw new Error("kp2 reorg_info missing");
  expect(cache2.reorg_info.split_heights).toBeDefined();
  expect(cache2.reorg_info.removed_outputs).toBeDefined();
  expect(cache2.reorg_info.removed_outputs.length).toBeGreaterThan(0);

  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(scanSettingsPath)).text(),
  );
  expect(cs.last_packet.status).toBe("OK");
}, 120000);

test("d: catastrophic reorg detected after node restart", async () => {
  const dir = `${OUT}/d`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  // start from 150 so anchors roll forward past genesis
  const scanSettingsPath = `${dir}/ScanSettings.json`;
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 150,
    },
    scanSettingsPath,
  );
  await rpc("generateblocks", {
    amount_of_blocks: 300,
    wallet_address: kp1.addr,
  });

  // Phase 1: initial scan via coordinator
  const gen = coordinatorMain(scanSettingsPath, `${dir}/`);
  const phase1Ok = await waitForScanReady(gen);
  expect(phase1Ok).toBe(true);
  console.log("[test d] initial scan done");

  // pop past the anchor at 150 so the blocks buffer finds no common hash
  const info = await rpc("get_info", {});
  const tip = info.result.height;
  const popAmount = tip - 149;
  console.log("[test d] tip=", tip, "pop=", popAmount);
  await fetch(`${URL}/pop_blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nblocks: popAmount }),
  });
  let catReorg = false;

  try {
    // Phase 2: continue coordinator,look for catastrophic_reorg
    for (let i = 0; i < 60; i++) {
      const { value, done } = await gen.next();
      if (done) break;
      if (
        value.type === "connection_status" &&
        value.status?.last_packet?.status === "catastrophic_reorg"
      ) {
        catReorg = true;
        break;
      }
      if (value.type === "scan_ready") break;
    }
  } catch (error) {
    if (error instanceof CatastrophicReorgError) {
      catReorg = true;
    }
  }

  const cs = JSON.parse(
    await Bun.file(connectionStatusFilePath(scanSettingsPath)).text(),
  );
  expect(catReorg).toBe(true);
  expect(cs.last_packet.status).toBe("catastrophic_reorg");
}, 30000);

afterAll(() => {
  try {
    proc.kill(9);
  } catch {}
  try {
    proc.exited;
  } catch {}
});
