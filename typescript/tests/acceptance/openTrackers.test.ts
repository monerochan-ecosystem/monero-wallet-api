// a tracker follows a plain library transfer on a regtest node. no handover and no tool call.
// the public API opens the tracker; a proxy records its node requests.
// the node command matches the reorg acceptance test.
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { makeTestKeyPair, NodeUrl, openTrackers, openWallets, ViewPair, writeScanSettings } from "../../dist/xmr3";

const run = Bun.env.RUN_TRACKERS_REGTEST === "1" ? test : test.skip;
const out = resolve("test-data/many-transaction-trackers-regtest");
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor(check: () => Promise<unknown>, what: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

run("openTrackers runs a signed library transfer through confirmation and a reorg", async () => {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const sender = await makeTestKeyPair();
  const merchant = (await makeTestKeyPair()).view_key;
  const primary = sender.view_key.mainnet_primary;
  const paymentId = 7;

  const node = `http://127.0.0.1:${await freePort()}`;
  // every request of the trackers, in order, with its body
  const requests: { name: string; body: string }[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    let call: { method?: string; params?: { hash?: string; height?: number; start_height?: number; end_height?: number } } = {};
    try { call = JSON.parse(body); } catch {}
    const name = call.method === "get_block" ? `get_block ${call.params?.height ?? call.params?.hash?.slice(0, 8)}`
      : call.method === "get_block_headers_range" ? `get_block_headers_range ${call.params?.start_height}-${call.params?.end_height}`
      : call.method || path;
    requests.push({ name, body });
    return fetch(node + path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } });
  const settings = out + "/ScanSettings.json";
  await writeScanSettings({ node_url: node, start_height: 0, wallets: [{ primary_address: primary }] }, settings);

  const proc = Bun.spawn([
    resolve(Bun.env.MONEROD_PATH ?? "tests/moneronode/monerod"),
    "--regtest", "--offline", "--fixed-difficulty", "1",
    "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", new URL(node).port,
    "--non-interactive",
  ], { stdin: "ignore", stdout: Bun.file(`${out}/node-stdout.log`), stderr: Bun.file(`${out}/node-stderr.log`) });

  async function post(url: string, body: unknown): Promise<any> {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`http ${response.status}: ${url}`);
    return response.json();
  }
  async function rpc(method: string, params = {}): Promise<any> {
    const data = await post(`${node}/json_rpc`, { jsonrpc: "2.0", id: "0", method, params });
    if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
    return data.result;
  }
  const mine = (count: number) => rpc("generateblocks", { amount_of_blocks: count, wallet_address: primary });
  const pop = (count: number) => post(node + "/pop_blocks", { nblocks: count });
  const top = async () => (await rpc("get_info")).height - 1;
  // the node puts a transaction into a block only after its relay step. that step runs some milliseconds after the answer.
  const inPool = (hash: string) => waitFor(async () => (await post(node + "/get_transaction_pool", {})).transactions?.some((tx: any) => tx.id_hash === hash && tx.relayed), "transaction in the pool");

  let wallets: Awaited<ReturnType<typeof openWallets>> | undefined;
  let many: Awaited<ReturnType<typeof openTrackers>> | undefined;
  Bun.env["vk" + primary] = sender.view_key.view_key;
  Bun.env["sk" + primary] = sender.spend_key;
  try {
    await waitFor(async () => (await rpc("get_info")).height, "node start");
    await mine(1000);
    const synced = Promise.withResolvers<void>();
    wallets = await openWallets({
      scan_settings_path: settings,
      pathPrefix: out + "/",
      no_stats: true,
      notifyMasterChanged: ({ newCache }) => {
        if ((newCache.scanned_ranges.at(-1)?.end ?? 0) >= 1000) synced.resolve();
      },
    });
    const wallet = wallets?.wallets[0];
    if (!wallet) throw new Error("sender wallet did not open");
    await Promise.race([synced.promise, Bun.sleep(60_000).then(() => { throw new Error("sender wallet did not sync"); })]);

    const opened = await openTrackers({
      node_url: `http://127.0.0.1:${proxy.port}`,
      interval: 60_000,
      notify: async ([{ data }]) => {
        if (data.state === "sending" && !requests.some(request => request.name === "/send_raw_transaction")) {
          await Bun.write(out + "/sending.json", JSON.stringify(data, null, 2));
        }
        await Bun.write(out + "/notified.json", JSON.stringify(data, null, 2));
      },
    });
    many = opened;
    const viewPair = await ViewPair.create(merchant.mainnet_primary, merchant.view_key);
    const payAddress = viewPair.makeIntegratedAddress(paymentId);

    // the plain library transfer: made and signed, not sent.
    const amount = "100000000000";
    wallet.decoyRetry = true;
    const tx_as_hex = await wallet.signTransaction(await wallet.makeStandardTransaction(payAddress, amount));
    await Bun.write(out + "/payment.hex", tx_as_hex);
    // signed 3 blocks before it is sent: the reorg below mines it again at the same height,
    // and a ring member that is still locked at a lower height would keep it out of a block.
    await mine(3);
    const start = await top();

    // results.json: each step with the requests of the trackers and the tracker after it
    const steps: Record<string, unknown>[] = [];
    let seen = 0;
    const step = async <T>(label: string, action: () => T | Promise<T>): Promise<T> => {
      let thrown: string | undefined;
      try { return await action(); }
      catch (error) { thrown = (error as Error).message; throw error; }
      finally {
        steps.push({
          step: label, thrown, top: await top(),
          requests: requests.slice(seen).map((request) => request.name),
          tracker: structuredClone(opened.transactionTrackers[0]?.data),
        });
        seen = requests.length;
        await Bun.write(out + "/results.json", JSON.stringify(steps, null, 2));
      }
    };
    const names = (from: number) => requests.slice(from).map((request) => request.name);
    const minedBlocks: { hash: string; height: number; tx_hashes: string[] }[] = [];
    async function paymentBlock(height: number, txHash: string): Promise<string> {
      const { block_header, tx_hashes } = await rpc("get_block", { height });
      minedBlocks.push({ hash: block_header.hash, height: block_header.height, tx_hashes });
      await Bun.write(out + "/mined-blocks.json", JSON.stringify(minedBlocks, null, 2));
      expect(block_header.height).toBe(height);
      expect(tx_hashes).toContain(txHash);
      return block_header.hash;
    }

    expect(opened.transactionTrackers).toHaveLength(0);

    const single = await step("scan and send the payment", () => opened.new({
      tx_as_hex, view_pair: viewPair, payment_id: paymentId, invoice_amount: BigInt(amount), merchant_confirmations: 3,
    }));
    if ("error" in single) throw new Error(single.error);
    const tx_hash = single.data.tx_hash;
    expect(single.data).toMatchObject({ state: "accepted", confirmations: 0, search_from_height: start - 20 });
    expect(await Bun.file(out + "/sending.json").json()).toMatchObject({
      state: "sending", tx_hash, tx_as_hex, payment_id: paymentId,
      search_from_height: start - 20, received_amount: amount,
    });
    await inPool(tx_hash);

    await step("track before the payment is mined", () => opened.track());
    await mine(1);
    await step("track after 1 block", () => opened.track());
    const first = await paymentBlock(start + 1, tx_hash);
    expect(single.data).toMatchObject({ state: "in_block", position: { height: start + 1, hash: first }, confirmations: 1 });
    const cache = new NodeUrl(`http://127.0.0.1:${proxy.port}`);
    const paymentHeight = start + 1;
    const parent = (await rpc("get_block", { height: start })).block_header.hash;
    let from = requests.length;
    expect((await cache.getCachedBlock({ height: start }))?.block_header.hash).toBe(parent);
    expect((await cache.getCachedBlock({ height: paymentHeight }))?.block_header.hash).toBe(first);
    expect((await cache.getCachedBlock({ height: paymentHeight }))?.block_header.hash).toBe(first);
    expect(names(from)).toEqual([`get_block ${start}`, `get_block ${paymentHeight}`]);

    // 6. a reorg removes the block. the transaction is in the pool again.
    await pop(1);
    await step("track after the reorg removed the block", () => opened.track());
    expect(single.data).toMatchObject({ state: "accepted", position: { height: start, hash: parent }, confirmations: 0 });
    await inPool(tx_hash);

    // 7. a new block at the same height takes it again
    await mine(1);
    await step("track after the new block", () => opened.track());
    const second = await paymentBlock(start + 1, tx_hash);
    expect(second).not.toBe(first);
    expect(single.data).toMatchObject({ state: "in_block", position: { height: start + 1, hash: second }, confirmations: 1 });

    // a later tip adds one confirmation
    await mine(1);
    await step("track after 1 more block", () => opened.track());
    expect(single.data).toMatchObject({ state: "in_block", confirmations: 2 });
    from = requests.length;
    expect((await cache.getCachedBlock({ height: paymentHeight + 1 }))?.block_header.prev_hash).toBe(second);
    expect((await cache.getCachedBlock({ height: paymentHeight + 1 }))?.block_header.prev_hash).toBe(second);
    expect((await cache.getCachedBlock({ height: start }))?.block_header.hash).toBe(parent);
    expect((await cache.getCachedBlock({ height: paymentHeight }))?.block_header.hash).toBe(second);
    expect((await cache.getCachedBlock({ height: paymentHeight }))?.block_header.hash).toBe(second);
    expect(names(from)).toEqual([`get_block ${paymentHeight + 1}`, `get_block ${start}`, `get_block ${paymentHeight}`]);

    // confirmation is final once merchant_confirmations is reached.
    await mine(1);
    await step("track after the third confirmation", () => opened.track());
    expect(single.data).toMatchObject({ state: "confirmed", position: { height: start + 1, hash: second }, confirmations: 3 });
    await pop(1);
    await step("track after a reorg, the tracker is confirmed", () => opened.track());
    expect(single.data).toMatchObject({ state: "confirmed", confirmations: 3 });

    // the trackers never named the transaction to the node. only the send has its bytes.
    expect(requests.filter((request) => request.name.startsWith("get_block_headers_range"))).toEqual([]);
    expect(requests.filter((request) => request.body.includes(tx_hash))).toEqual([]);
    expect(requests.filter((request) => request.body.includes(tx_as_hex)).map((request) => request.name)).toEqual(["/send_raw_transaction"]);
    await Bun.write(out + "/requests.json", JSON.stringify(requests.map((request) => request.name), null, 2));
    await Bun.write(out + "/tracker.json", JSON.stringify(single.data, null, 2));
  } finally {
    try {
      await many?.stop();
      wallets?.unwatchConnectionStatus();
      await wallets?.stopWorker();
    } finally {
      proxy.stop(true);
      proc.kill();
      await proc.exited;
      delete Bun.env["vk" + primary];
      delete Bun.env["sk" + primary];
    }
  }
}, { timeout: 240_000 });
