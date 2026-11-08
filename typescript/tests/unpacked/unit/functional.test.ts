import { test, expect, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ManyScanCachesOpened } from "../../../wallet-api/scanning-syncing/scanresult/scanCacheOpened";
import type { WorkerSet } from "../../../wallet-api/scanning-syncing/backgroundWorker";

const OUT = "test-data/unpacked_functional";

async function clean() {
  await rm(OUT, { force: true, recursive: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
}

test("unpacked makeTestKeyPair works via file urls", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  // point loader to dist wasm files
  unpacked.configureUnpacked({
    workerUrl: "dist/worker_unpacked.js",
    moneroWasmUrl: "dist/monero_wallet_api.wasm",
    dkgWasmUrl: "dist/frost_dkg.wasm",
  });
  // urls win over inline, so this uses file bytes even if packed ran before
  const fileBytes = new Uint8Array(
    await Bun.file("dist/monero_wallet_api.wasm").arrayBuffer(),
  );
  const loaderBytes = await unpacked.getMoneroWasmBytes();
  expect(loaderBytes.length).toBe(fileBytes.length);
  expect(loaderBytes[0]).toBe(0x00);
  expect(loaderBytes[1]).toBe(0x61);
  // real wasm call
  const kp = await unpacked.makeTestKeyPair();
  expect(kp.spend_key.length).toBe(64);
  expect(kp.view_key.mainnet_primary.length).toBeGreaterThan(90);
}, 10000);

test("unpacked parseAddress works", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  unpacked.configureUnpacked({
    workerUrl: "dist/worker_unpacked.js",
    moneroWasmUrl: "dist/monero_wallet_api.wasm",
    dkgWasmUrl: "dist/frost_dkg.wasm",
  });
  const kp = await unpacked.makeTestKeyPair();
  const parsed = await unpacked.parseAddress(kp.view_key.mainnet_primary);
  expect("address" in parsed).toBe(true);
}, 10000);

test("unpacked worker starts and signals ready", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  unpacked.configureUnpacked({
    workerUrl: `${process.cwd()}/dist/worker_unpacked.js`,
    moneroWasmUrl: `${process.cwd()}/dist/monero_wallet_api.wasm`,
    dkgWasmUrl: `${process.cwd()}/dist/frost_dkg.wasm`,
  });
  const worker = await unpacked.startWebworkerReady();
  expect(worker).toBeDefined();
  worker.terminate();
}, 10000);

// real worker transport with a held local block request. no monerod or public node
const transportCleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of transportCleanup.splice(0)) await close();
});

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 600);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

async function transportFixture(name: string) {
  const dir = resolve(OUT, name);
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
  const unpacked = await import("../../../wallet-api/xmr3_unpacked");
  unpacked.configureUnpacked({
    workerUrl: resolve("wallet-api/scanning-syncing/worker-mains/worker.ts"),
    moneroWasmUrl: resolve("dist/monero_wallet_api.wasm"),
    dkgWasmUrl: resolve("dist/frost_dkg.wasm"),
  });
  const pair = await unpacked.makeTestKeyPair();
  const address = pair.view_key.mainnet_primary;
  const key = "vk" + address;
  const previous = Bun.env[key];
  Bun.env[key] = pair.view_key.view_key;
  const entered = Promise.withResolvers<void>();
  const held: ((response: Response) => void)[] = [];
  const methods: string[] = [];
  const errors: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/getblocks.bin") {
        entered.resolve();
        return new Promise<Response>((resolve) => held.push(resolve));
      }
      const message = await request.json() as { method: string; params?: { start_height: number } };
      methods.push(message.method);
      if (message.method === "get_block_headers_range") return Response.json({ id: "0", jsonrpc: "2.0", result: {
        status: "OK", credits: 0, top_hash: "", untrusted: false,
        headers: [{ block_size: 0, block_weight: 0, cumulative_difficulty: 1, cumulative_difficulty_top64: 0,
          depth: 0, difficulty: 1, difficulty_top64: 0, hash: "11".repeat(32), height: message.params?.start_height ?? 0,
          long_term_weight: 0, major_version: 16, miner_tx_hash: "22".repeat(32), minor_version: 0, nonce: 0,
          num_txes: 0, orphan_status: false, pow_hash: "", prev_hash: "00".repeat(32), reward: 0,
          timestamp: 1, wide_cumulative_difficulty: "1", wide_difficulty: "1" }],
      } });
      if (message.method !== "get_info") return Response.json({ error: "unexpected fixture method" }, { status: 500 });
      return Response.json({ id: "0", jsonrpc: "2.0", result: {
        adjusted_time: 0, alt_blocks_count: 0, block_size_limit: 0, block_size_median: 0,
        block_weight_limit: 0, block_weight_median: 0, bootstrap_daemon_address: "", busy_syncing: false,
        credits: 0, cumulative_difficulty: 0, cumulative_difficulty_top64: 0, database_size: 0,
        difficulty: 1, difficulty_top64: 0, free_space: 0, grey_peerlist_size: 0, height: 51,
        height_without_bootstrap: 51, incoming_connections_count: 0, mainnet: false, nettype: "fakechain",
        offline: true, outgoing_connections_count: 0, restricted: false, rpc_connections_count: 0,
        stagenet: false, start_time: 0, status: "OK", synchronized: true, target: 120, target_height: 51,
        testnet: false, top_block_hash: "11".repeat(32), top_hash: "11".repeat(32), tx_count: 0,
        tx_pool_size: 0, untrusted: false, update_available: false, version: "test",
        was_bootstrap_ever_used: false, white_peerlist_size: 0, wide_cumulative_difficulty: "1", wide_difficulty: "1",
      } });
    },
  });
  let mco: ManyScanCachesOpened | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    mco?.unwatchConnectionStatus();
    await mco?.stopWorker();
    for (const release of held) release(new Response("fixture closed", { status: 503 }));
    await server.stop(true);
    if (previous === undefined) delete Bun.env[key];
    else Bun.env[key] = previous;
    await Bun.write(`${dir}/worker-log.json`, JSON.stringify({ methods, errors }, null, 2));
  };
  transportCleanup.push(close);
  const block = { block_height: 50, block_timestamp: 1, block_hash: "11".repeat(32) };
  const path = `${dir}/${address}_cache.json`;
  await Bun.write(path, JSON.stringify({
    primary_address: address, outputs: {}, own_key_images: {}, daemon_height: 51,
    scanned_ranges: [{ start: 0, end: 50, block_hashes: [block, block, block] }], tx_logs: [], pending_spent_utxos: {},
  }));
  await Bun.write(`${dir}/ScanSettings.json`, JSON.stringify({
    node_url: server.url.href.replace(/\/$/, ""), start_height: 0, cpu_worker_count: 1,
    wallets: [{ primary_address: address }],
  }));
  mco = await unpacked.openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true, workerError: (error) => errors.push(String(error)) });
  await withDeadline(entered.promise, "worker did not enter the held block fetch");
  const worker = (mco.wallets[0] as unknown as { worker: WorkerSet }).worker;
  const message = { primary_address: address, txLog: { timestamp: 1, height: 50, inputs_index: [], payments: [], node_url: mco.node_url } };
  return { dir, path, mco, worker, message, methods, errors, close };
}

test("production worker reads its genesis header from the local fixture", async () => {
  const fixture = await transportFixture("transport-genesis");
  try {
    expect(fixture.methods).toContain("get_block_headers_range");
    expect(fixture.errors).toEqual([]);
    expect(fixture.worker.cpuWorkers).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("production cache message writes the file and returns its assigned index", async () => {
  const fixture = await transportFixture("transport-write");
  try {
    const index = await withDeadline(fixture.worker.writeCache(fixture.message), "cache reply missing");
    const cache = JSON.parse(await Bun.file(fixture.path).text());
    expect(index).toBe(0);
    expect(cache.tx_logs).toHaveLength(1);
    expect(cache.tx_logs[index].timestamp).toBe(1);
    expect(fixture.mco.wallets[0]!.tx_logs[index]!.timestamp).toBe(1);
    await Bun.write(`${fixture.dir}/result.json`, JSON.stringify({ index, cache }, null, 2));
  } finally {
    await fixture.close();
  }
});

test("production cache message rejects an invalid index and accepts the next write", async () => {
  const fixture = await transportFixture("transport-error");
  try {
    await expect(withDeadline(fixture.worker.writeCache({ ...fixture.message, txLogIndex: 99 }), "cache error reply missing")).rejects.toThrow("tx log missing");
    const index = await withDeadline(fixture.worker.writeCache(fixture.message), "cache reply missing after an error");
    const cache = JSON.parse(await Bun.file(fixture.path).text());
    expect(index).toBe(0);
    expect(cache.tx_logs).toHaveLength(1);
    await Bun.write(`${fixture.dir}/result.json`, JSON.stringify({ index, cache }, null, 2));
  } finally {
    await fixture.close();
  }
});

test("production cache reply waiting at shutdown rejects instead of hanging", async () => {
  const fixture = await transportFixture("transport-shutdown");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = fixture.worker.fetchWorker;
  const original = worker.onmessage!;
  worker.onmessage = async (event) => {
    if (event.data.type === "SCAN_RESULT") { entered.resolve(); await release.promise; }
    await original.call(worker, event);
  };
  try {
    const pending = fixture.worker.writeCache(fixture.message).then(
      () => ({ error: "write unexpectedly resolved" }), (error) => ({ error: String(error) }),
    );
    await withDeadline(entered.promise, "cache result did not reach the parent");
    await fixture.mco.stopWorker();
    const result = await withDeadline(pending, "cache write did not reject at shutdown");
    expect(result.error).toContain("scanner stopped");
    const cache = JSON.parse(await Bun.file(fixture.path).text());
    expect(cache.tx_logs).toHaveLength(1);
    await Bun.write(`${fixture.dir}/result.json`, JSON.stringify({ ...result, committedRows: cache.tx_logs.length }, null, 2));
  } finally {
    release.resolve();
    await fixture.close();
  }
});
