import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Trackers as BuiltTrackers } from "../../../dist/xmr3";
import type { GetBlock, SendRawTransactionResult } from "../../../wallet-api/node-interaction/jsonEndpoints";
import { NodeUrl } from "../../../wallet-api/node-interaction/nodeUrl";
import { openTrackers, TransactionTracker, type OpenTrackersOptions, type Trackers } from "../../../wallet-api/node-interaction/openTrackers";
import { ViewPair } from "../../../wallet-api/viewpair/ViewPair";
import type { ScannedTransaction } from "../../../wallet-api/viewpair/transactionParsing";

const tx_hash = "ab".repeat(32);
const tx_as_hex = "0102";
const payment_id = 42;
const invoice_amount = 100n;

class TestViewPair extends ViewPair {
  constructor(private hash = tx_hash, private amount = invoice_amount) {
    super("http://node", "merchant");
  }

  public override scanTransaction({ payment_id: expected }: Parameters<ViewPair["scanTransaction"]>[0]): ScannedTransaction {
    const outputs = expected === payment_id ? [{
      index_in_transaction: 0,
      stealth_address: "01".repeat(32),
      amount: this.amount.toString(),
      payment_id: String(payment_id),
      subaddress_index: null,
    }] : [];
    return { tx_hash: this.hash, unlock_time: "0", outputs, received_amount: outputs.length ? this.amount : 0n };
  }
}

const paymentOptions = { tx_as_hex, payment_id, invoice_amount, view_pair: new TestViewPair() };

async function newTracker(trackers: Trackers, options: Parameters<Trackers["new"]>[0]): Promise<TransactionTracker> {
  const result = await trackers.new(options);
  if ("error" in result) throw new Error(result.error);
  return result;
}

const accepted: SendRawTransactionResult = {
  status: "OK", reason: "", double_spend: false, fee_too_low: false,
  invalid_input: false, invalid_output: false, low_mixin: false, not_relayed: false,
  overspend: false, too_big: false, untrusted: false,
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(options: OpenTrackersOptions = {}) {
  const blocks: GetBlock[] = [];
  const reads: number[] = [];
  const hash = (id: number) => id.toString(16).padStart(64, "0");
  let nextHash = 1;
  function mine(...tx_hashes: string[]) {
    const block = {
      block_header: {
        height: blocks.length,
        hash: hash(nextHash++),
        prev_hash: blocks.at(-1)?.block_header.hash ?? hash(0),
        depth: 0,
        timestamp: 1_700_000_000 + blocks.length * 120,
      },
      miner_tx_hash: hash(0),
      tx_hashes,
    };
    blocks.push(block);
    return block;
  }
  for (let i = 0; i < 11; i++) mine();

  const getInfo = spyOn(NodeUrl.prototype, "getInfo").mockImplementation(async () => ({
    height: blocks.length,
    top_block_hash: blocks.at(-1)!.block_header.hash,
  } as Awaited<ReturnType<NodeUrl["getInfo"]>>));
  const getBlock = spyOn(NodeUrl.prototype, "getBlock").mockImplementation(async params => {
    const block = "height" in params ? blocks[params.height] : blocks.find(b => b.block_header.hash === params.hash);
    if (!block) return null;
    reads.push(block.block_header.height);
    return block;
  });
  const send = spyOn(NodeUrl.prototype, "sendRawTransaction").mockResolvedValue(accepted);
  let deliverTip: ((tip?: GetBlock, started_at?: number) => Promise<void>) | undefined;
  const pollTip = spyOn(NodeUrl.prototype, "pollTip").mockImplementation(async (notify, signal) => {
    deliverTip = async (tip, started_at) => { await notify(tip ?? blocks.at(-1)!, signal, started_at); };
  });
  cleanup.push(() => {
    getInfo.mockRestore();
    getBlock.mockRestore();
    send.mockRestore();
    pollTip.mockRestore();
  });
  const trackers = await openTrackers(options);
  cleanup.push(() => trackers.stop());
  return { blocks, reads, mine, getInfo, getBlock, send, trackers, deliverTip: deliverTip! };
}

test("wrong payment ID and invoice amount stop before tracking or broadcast", async () => {
  const notify = mock(() => {});
  const { getInfo, send, trackers } = await setup({ notify });
  const options = { ...paymentOptions, merchant_confirmations: 3 };
  const view_pair = new TestViewPair();
  spyOn(view_pair, "scanTransaction").mockImplementation(() => { throw new Error("invalid transaction hex"); });

  expect(await trackers.new({ ...options, tx_as_hex: "bad hex", view_pair }))
    .toEqual({ error: "invalid transaction hex" });
  expect(await trackers.new({ ...options, payment_id: payment_id + 1 }))
    .toEqual({ error: "transaction does not pay the expected payment ID" });
  expect(await trackers.new({ ...options, invoice_amount: invoice_amount + 1n }))
    .toEqual({ error: "payment is below the invoice amount" });
  expect(getInfo).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(trackers.transactionTrackers).toHaveLength(0);
});

test("send records and saves the starting state before publishing the bytes", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1000);
  cleanup.push(() => now.mockRestore());
  const events: string[] = [];
  const { send, trackers } = await setup({
    notify: ([tracker]) => {
      expect(tracker!.data).toMatchObject({ search_from_height: 10, tx_hash, tx_as_hex, timestamp: Date.now() });
      events.push(tracker!.data.state);
    },
  });
  send.mockImplementation(async hex => {
    expect(hex).toBe(tx_as_hex);
    expect(events).toEqual(["sending"]);
    events.push("rpc");
    now.mockReturnValue(2000);
    return accepted;
  });
  const tracker = await newTracker(trackers, { ...paymentOptions, invoice_amount: invoice_amount - 1n, merchant_confirmations: 3 });
  expect(events).toEqual(["sending", "rpc", "accepted"]);
  expect(trackers.transactionTrackers).toEqual([tracker]);
  expect(tracker.data).toMatchObject({ state: "accepted", confirmations: 0 });
  expect(tracker.transaction.amount).toBe(invoice_amount);
});

test("restore keeps the latest state for each wallet and payment ID", async () => {
  const older = {
    tx_hash, payment_id, primary_address: "merchant", state: "accepted" as const,
    merchant_confirmations: 3, confirmations: 0, search_from_height: 10, timestamp: 1000,
  };
  const newer = {
    ...older, timestamp: 2000, state: "in_block" as const, confirmations: 1,
    position: { height: 11, hash: "cd".repeat(32) },
  };
  const latest = new TransactionTracker({ ...newer, confirmations: 2 });
  const otherWallet = { ...older, primary_address: "other merchant" };
  const otherPayment = { ...older, payment_id: payment_id + 1 };
  const withoutWallet = { ...older, primary_address: undefined };
  const anotherWithoutWallet = { ...withoutWallet, timestamp: 2000 };
  const { trackers } = await setup({
    transactionTrackers: [newer, latest, otherWallet, otherPayment, older, withoutWallet, anotherWithoutWallet],
  });

  expect(trackers.transactionTrackers[0]).toBe(latest);
  expect(trackers.transactionTrackers.map(({ data }) => data)).toEqual([
    latest.data, otherWallet, otherPayment, withoutWallet, anotherWithoutWallet,
  ]);
});

test("removeTracker matches both the wallet and payment ID", async () => {
  const saved = {
    tx_hash, payment_id, primary_address: "merchant", state: "accepted" as const,
    merchant_confirmations: 3, confirmations: 0, search_from_height: 10, timestamp: 1000,
  };
  const otherWallet = { ...saved, primary_address: "other merchant" };
  const otherPayment = { ...saved, payment_id: payment_id + 1 };
  const { trackers } = await setup({ transactionTrackers: [otherWallet, otherPayment, saved] });

  trackers.removeTracker({ payment_id, primary_address: saved.primary_address });

  expect(trackers.transactionTrackers.map(({ data }) => data)).toEqual([otherWallet, otherPayment]);
});

test("a tip sends one batch with all changed payments", async () => {
  const notify = mock((_trackers: readonly TransactionTracker[]) => {});
  const { mine, trackers, deliverTip } = await setup({ notify });
  const otherHash = "cd".repeat(32);
  const first = await newTracker(trackers, { ...paymentOptions, merchant_confirmations: 3 });
  const second = await newTracker(trackers, { ...paymentOptions, tx_as_hex: "0304", view_pair: new TestViewPair(otherHash), merchant_confirmations: 3 });
  notify.mockClear();

  mine(tx_hash, otherHash);
  await deliverTip();
  expect([first.data.confirmations, second.data.confirmations]).toEqual([1, 1]);
  expect(notify.mock.calls).toEqual([[[first, second]]]);

  await deliverTip();
  expect(notify).toHaveBeenCalledTimes(1);

  mine();
  await trackers.track();
  expect([first.data.confirmations, second.data.confirmations]).toEqual([2, 2]);
  expect(notify.mock.calls).toEqual([[[first, second]], [[first, second]]]);
});

test("a tip change fills gaps and a same-height reorg replaces the payment block", async () => {
  const { blocks, mine, reads, trackers, deliverTip } = await setup();
  const tracker = await newTracker(trackers, { ...paymentOptions, merchant_confirmations: 4 });
  const original = mine(tx_hash);
  mine();
  mine();
  reads.length = 0;
  await deliverTip();
  expect(reads).toContain(12);
  expect(tracker.data).toMatchObject({
    state: "in_block", position: { height: 11, hash: original.block_header.hash }, confirmations: 3,
  });

  blocks.length = 11;
  mine();
  mine();
  const newTip = mine();
  await deliverTip();
  expect(tracker.data).toMatchObject({
    state: "accepted", position: { height: 13, hash: newTip.block_header.hash }, confirmations: 0,
  });
  expect(tracker.transaction.block_height).toBeUndefined();
  expect(tracker.transaction.block_timestamp).toBeUndefined();

  const replacement = mine(tx_hash);
  await trackers.track();
  expect(tracker.data).toMatchObject({
    state: "in_block", position: { height: 14, hash: replacement.block_header.hash }, confirmations: 1,
  });
  mine();
  mine();
  mine();
  await deliverTip();
  expect(tracker.data).toMatchObject({ state: "confirmed", confirmations: 4 });
  const confirmed = tracker.data;
  const chain = new Map(blocks.map(block => [block.block_header.height, block]));
  tracker.track(blocks.at(-1)!, chain, replacement);
  expect(tracker.data).toBe(confirmed);
});

test("a bad predecessor leaves the tracker unchanged until the chain can be read", async () => {
  const { blocks, mine, trackers } = await setup();
  const tracker = await newTracker(trackers, { ...paymentOptions, merchant_confirmations: 4 });
  const payment = mine(tx_hash);
  const predecessor = mine();
  mine();
  blocks[12] = { ...predecessor, block_header: { ...predecessor.block_header, hash: "ff".repeat(32) } };
  const previous = structuredClone(tracker.data);

  await expect(trackers.track()).rejects.toThrow();
  expect(tracker.data).toEqual(previous);

  blocks[12] = predecessor;
  await trackers.track();
  expect(tracker.data).toMatchObject({
    state: "in_block", position: { height: 11, hash: payment.block_header.hash }, confirmations: 3,
  });
});

test("a delayed tip read cannot undo a newer confirmation count", async () => {
  const { getInfo, mine, trackers } = await setup();
  const tracker = await newTracker(trackers, { ...paymentOptions, merchant_confirmations: 4 });
  const payment = mine(tx_hash);
  const delayed = Promise.withResolvers<Awaited<ReturnType<NodeUrl["getInfo"]>>>();
  getInfo.mockImplementationOnce(() => delayed.promise);
  const old = trackers.track();

  mine();
  try {
    await trackers.track();
    expect(tracker.data.confirmations).toBe(2);
  } finally {
    delayed.resolve({
      height: 12, top_block_hash: payment.block_header.hash,
    } as Awaited<ReturnType<NodeUrl["getInfo"]>>);
    await old;
  }
  expect(tracker.data.confirmations).toBe(2);
});

test("an older poll cannot undo a newer manual refresh", async () => {
  const { deliverTip, mine, trackers } = await setup();
  const tracker = await newTracker(trackers, { ...paymentOptions, merchant_confirmations: 4 });
  const payment = mine(tx_hash);
  const started_at = performance.now();
  mine();
  await trackers.track();
  await deliverTip(payment, started_at);
  expect(tracker.data.confirmations).toBe(2);
});

test("a restarted tracker follows the chain from its saved position", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1000);
  cleanup.push(() => now.mockRestore());
  const { mine, reads, trackers } = await setup();
  const received_amount = 9_007_199_254_740_993n;
  const original = await newTracker(trackers, {
    ...paymentOptions,
    view_pair: new TestViewPair(tx_hash, received_amount),
    invoice_amount: received_amount,
    merchant_confirmations: 3,
  });
  mine();
  mine();
  await trackers.track();
  const saved = JSON.parse(JSON.stringify(original.data));
  expect(saved.received_amount).toBe(received_amount.toString());
  await trackers.stop();

  now.mockReturnValue(2000);
  const reopened = await openTrackers({ transactionTrackers: [saved] });
  cleanup.push(() => reopened.stop());
  expect(reopened.transactionTrackers[0]?.data).toMatchObject({ timestamp: 1000 });
  const payment = mine(tx_hash);
  reads.length = 0;
  await reopened.track();
  expect(reads.every(height => height >= 12)).toBe(true);
  expect(reopened.transactionTrackers[0]?.data).toMatchObject({
    state: "in_block", search_from_height: 10, position: { height: 13, hash: payment.block_header.hash }, confirmations: 1, timestamp: 2000,
  });
  expect(reopened.transactionTrackers[0]?.transaction).toEqual({
    tx_hash, payment_id: 42, amount: received_amount, confirmations: 1, state: "in_block",
    block_height: 13, block_timestamp: payment.block_header.timestamp,
  });
  now.mockReturnValue(3000);
  await reopened.track();
  expect(reopened.transactionTrackers[0]?.data).toMatchObject({ timestamp: 2000 });
});

test("a failed persistence callback prevents the broadcast", async () => {
  const { send, trackers } = await setup({ notify: () => { throw new Error("storage unavailable"); } });
  await expect(trackers.new({ ...paymentOptions, merchant_confirmations: 3 })).rejects.toThrow("storage unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(trackers.transactionTrackers).toHaveLength(0);
});

test("a lost send reply leaves a saved tracker that can find the payment", async () => {
  const { send, mine, trackers } = await setup();
  send.mockRejectedValueOnce(new Error("reply lost"));
  await expect(trackers.new({ ...paymentOptions, merchant_confirmations: 2 })).rejects.toThrow("reply lost");
  const tracker = trackers.transactionTrackers[0]!;
  expect(tracker.data).toMatchObject({ state: "sending", tx_as_hex, tx_hash });
  mine(tx_hash);
  mine();
  await trackers.track();
  expect(tracker.data).toMatchObject({ state: "confirmed", confirmations: 2 });
});

test("an explicit first rejection preserves the bytes for a retry", async () => {
  const { send, trackers } = await setup();
  send.mockResolvedValueOnce({ ...accepted, status: "Failed", reason: "invalid input" });
  await expect(trackers.new({ ...paymentOptions, merchant_confirmations: 2 })).rejects.toThrow("invalid input");
  const tracker = trackers.transactionTrackers[0]!;
  expect(tracker.data).toMatchObject({ state: "scanned", confirmations: 0, tx_hash, tx_as_hex });
  await trackers.new(tracker);
  expect(tracker.data.state).toBe("accepted");
  expect(send).toHaveBeenCalledTimes(2);
});

// integration: use wasm and a local rpc server for both package builds.
const hash = (height: number) => height.toString(16).padStart(64, "0");

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function entry(mode: "packed" | "unpacked") {
  const { resetWasmLoaderForTests } = await import("../../../dist/wasm-processing/wasmLoader");
  resetWasmLoaderForTests();
  if (mode === "packed") return import("../../../dist/xmr3");
  const api = await import("../../../dist/xmr3_unpacked");
  api.configureUnpacked({
    workerUrl: resolve("dist/worker_unpacked.js"),
    moneroWasmUrl: resolve("dist/monero_wallet_api.wasm"),
    dkgWasmUrl: resolve("dist/frost_dkg.wasm"),
  });
  return api;
}

async function setupRpc(name: string) {
  const dir = resolve("test-data/open-trackers-http", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const requests: { method: string; height?: number; tx_bytes?: number }[] = [];
  let top = 20;
  const payments = new Map<number, string[]>();
  const header = (height: number) => ({
    block_size: 0, block_weight: 0, cumulative_difficulty: 1, cumulative_difficulty_top64: 0,
    depth: top - height, difficulty: 1, difficulty_top64: 0, hash: hash(height), height,
    long_term_weight: 0, major_version: 16, miner_tx_hash: hash(1000 + height), minor_version: 0,
    nonce: 0, num_txes: payments.get(height)?.length ?? 0, orphan_status: false, pow_hash: "",
    prev_hash: hash(height - 1), reward: 0, timestamp: 1, wide_cumulative_difficulty: "1", wide_difficulty: "1",
  });
  const info = () => ({
    adjusted_time: 0, alt_blocks_count: 0, block_size_limit: 0, block_size_median: 0,
    block_weight_limit: 0, block_weight_median: 0, bootstrap_daemon_address: "", busy_syncing: false,
    credits: 0, cumulative_difficulty: 0, cumulative_difficulty_top64: 0, database_size: 0,
    difficulty: 1, difficulty_top64: 0, free_space: 0, grey_peerlist_size: 0, height: top + 1,
    height_without_bootstrap: top + 1, incoming_connections_count: 0, mainnet: false, nettype: "fakechain",
    offline: true, outgoing_connections_count: 0, restricted: false, rpc_connections_count: 0,
    stagenet: false, start_time: 0, status: "OK", synchronized: true, target: 120, target_height: top + 1,
    testnet: false, top_block_hash: hash(top), top_hash: "", tx_count: 0, tx_pool_size: 0,
    untrusted: false, update_available: false, version: "test", was_bootstrap_ever_used: false,
    white_peerlist_size: 0, wide_cumulative_difficulty: "1", wide_difficulty: "1",
  });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { method?: string; params?: { height: number }; tx_as_hex?: string };
      const method = body.method ?? new URL(request.url).pathname;
      requests.push({ method, height: body.params?.height, tx_bytes: body.tx_as_hex === undefined ? undefined : body.tx_as_hex.length / 2 });
      if (method === "/send_raw_transaction") return Response.json({
        status: "OK", reason: "", double_spend: false, fee_too_low: false, invalid_input: false,
        invalid_output: false, low_mixin: false, not_relayed: false, overspend: false, too_big: false, untrusted: false,
      });
      const height = body.params?.height;
      const result = method === "get_info" ? info()
        : method === "get_block" && height !== undefined
          ? { block_header: header(height), miner_tx_hash: header(height).miner_tx_hash, tx_hashes: payments.get(height) ?? [] }
          : undefined;
      if (!result) return Response.json({ error: "unexpected request" }, { status: 500 });
      return Response.json({ id: "0", jsonrpc: "2.0", result });
    },
  });
  return {
    dir, requests, node_url: server.url.href.replace(/\/$/, ""),
    mine: (txs: string[]) => { payments.set(++top, txs); },
    async close(many?: BuiltTrackers) {
      await many?.stop();
      await server.stop(true);
      await Bun.write(`${dir}/requests.json`, JSON.stringify(requests, null, 2));
    },
  };
}

for (const mode of ["packed", "unpacked"] as const) {
  test(`${mode}: a scanned payment is saved before send and followed by the tip poller`, async () => {
    const fixture = await Bun.file("tests/tools/unit/scan-fixture.json").json();
    const paymentId = Number(fixture.expected.payment_id);
    const api = await entry(mode);
    const local = await setupRpc(`${mode}-scan-send`);
    let many: BuiltTrackers | undefined;
    const confirmed = Promise.withResolvers<void>();
    const states: string[] = [];
    const errors: Error[] = [];
    try {
      const viewPair = await api.ViewPair.create(fixture.primary_address, fixture.secret_view_key);
      const tx_as_hex = fixture.tx_as_hex;
      const tx_hash = fixture.expected.tx_hash;
      const invoice_amount = BigInt(fixture.expected.amount);

      many = await api.openTrackers({
        node_url: local.node_url, interval: 10, onError: error => errors.push(error),
        notify: async ([{ data }]) => {
          if (data.state === "sending" && states.length === 0) {
            expect(local.requests.some(request => request.method === "/send_raw_transaction")).toBe(false);
            await Bun.write(`${local.dir}/sending.json`, JSON.stringify(data, null, 2));
          }
          if (states.at(-1) !== data.state) states.push(data.state);
          if (data.state === "confirmed") confirmed.resolve();
        },
      });
      const options = { tx_as_hex, view_pair: viewPair, payment_id: paymentId, invoice_amount, merchant_confirmations: 2 };
      expect(await many.new({ ...options, tx_as_hex: "bad hex" }))
        .toEqual({ error: "invalid transaction hex" });
      expect(await many.new({ ...options, payment_id: paymentId + 1 }))
        .toEqual({ error: "transaction does not pay the expected payment ID" });
      expect(await many.new({ ...options, invoice_amount: invoice_amount + 1n }))
        .toEqual({ error: "payment is below the invoice amount" });
      expect(many.transactionTrackers).toHaveLength(0);
      expect(states).toHaveLength(0);
      expect(local.requests.some(request => request.method === "/send_raw_transaction")).toBe(false);

      const tracker = await many.new({ ...options, invoice_amount: invoice_amount - 1n });
      if ("error" in tracker) throw new Error(tracker.error);
      expect(tracker.data.state).toBe("accepted");
      const saved = await Bun.file(`${local.dir}/sending.json`).json();
      expect(saved).toMatchObject({ state: "sending", tx_hash, tx_as_hex, payment_id: paymentId, search_from_height: 20, received_amount: fixture.expected.amount });
      const sends = local.requests.filter(request => request.method === "/send_raw_transaction");
      expect(sends).toEqual([{ method: "/send_raw_transaction", height: undefined, tx_bytes: tx_as_hex.length / 2 }]);

      local.mine([tx_hash]);
      local.mine([]);
      await deadline(confirmed.promise, "tip poller did not confirm the payment");
      expect(tracker.data).toMatchObject({
        state: "confirmed", position: { height: 21, hash: hash(21) }, confirmations: 2,
      });
      expect(states).toEqual(["sending", "accepted", "confirmed"]);
      expect(local.requests.filter(request => request.method === "get_block").map(request => request.height)).toContain(21);
      expect(errors).toEqual([]);
      await Bun.write(`${local.dir}/result.json`, JSON.stringify(tracker.data, null, 2));
    } finally {
      await local.close(many);
    }
  }, { timeout: 20_000 });
}
