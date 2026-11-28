import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { NodeUrl, ViewPair, Trackers, ScannedTransaction, TransactionTrackerState } from "../../../dist/xmr3";

const sdk = await import(
  Bun.resolveSync("@spirobel/monero-wallet-api", resolve("../walletless-checkout"))
) as typeof import("../../../dist/xmr3");

const oldDatabase = Bun.env.CHECKOUT_DB;
Bun.env.CHECKOUT_DB = ":memory:";
const db = await import("../../../../standard-checkout/db");
afterAll(() => { if (oldDatabase === undefined) delete Bun.env.CHECKOUT_DB; else Bun.env.CHECKOUT_DB = oldDatabase; });
// checkout.test.ts can run first in the same bun process. it shares this in-memory database and leaves open trackers.
for (const row of await db.getOpenTrackedSessions()) await db.markAsPaid(row.id);
const primary_address = "primary";
const accepted = { status: "OK", reason: "", double_spend: false };
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

class TestViewPair extends sdk.ViewPair {
  constructor(private scans: Map<string, ScannedTransaction>) { super("http://node", primary_address); }
  public override scanTransaction({ tx_as_hex, payment_id, invoice_amount }: Parameters<ViewPair["scanTransaction"]>[0]): ScannedTransaction {
    const scan = this.scans.get(tx_as_hex.toLowerCase());
    if (!scan) throw new Error("invalid transaction");
    const outputs = payment_id === undefined ? scan.outputs : scan.outputs.filter(output => output.payment_id === String(payment_id));
    const received_amount = outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n);
    return {
      ...scan, payment_id, outputs, received_amount,
      invoice_amount_matches: invoice_amount === undefined ? undefined : outputs.length > 0 && received_amount === invoice_amount,
    };
  }
}

async function setup(name: string, send?: (hex: string) => Promise<typeof accepted>, failSave = false) {
  const directory = resolve(`test-data/walletless-tracker/${name}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await Bun.write(`${directory}/input.json`, JSON.stringify({ name, failSave }));
  const row = (await db.createCheckoutSession("0.1", crypto.randomUUID(), 3))[0];
  await db.updateCheckoutSessionAddress(row.session_id, "address");
  const scans = new Map<string, ScannedTransaction>();
  const calls: string[] = [];
  let many!: Trackers;
  let top = 10;
  const payments = new Map<number, string>();
  let nodeDown = false;
  const header = (height: number) => ({ height, hash: `block${height}`, prev_hash: `block${height - 1}`, depth: top - height });
  const info = spyOn(sdk.NodeUrl.prototype, "getInfo").mockImplementation(async () => {
    if (nodeDown) throw new Error("node unavailable");
    return { height: top + 1, top_block_hash: "block" + top } as Awaited<ReturnType<NodeUrl["getInfo"]>>;
  });
  const blocks = spyOn(sdk.NodeUrl.prototype, "getBlock").mockImplementation(async (params) => {
    const height = "height" in params ? params.height : Number(params.hash.slice(5));
    const payment = payments.get(height);
    return { block_header: header(height), miner_tx_hash: "", tx_hashes: payment ? [payment] : [] };
  });
  const broadcast = spyOn(sdk.NodeUrl.prototype, "sendRawTransaction").mockImplementation(async hex => {
    calls.push(hex);
    return (send ? await send(hex) : accepted) as Awaited<ReturnType<NodeUrl["sendRawTransaction"]>>;
  });
  const view = new TestViewPair(scans);
  const scan = spyOn(view, "scanTransaction");
  const create = spyOn(sdk.ViewPair, "create").mockResolvedValue(view);
  for (const mock of [info, blocks, broadcast, scan, create]) restores.push(() => mock.mockRestore());
  const open: typeof sdk.openTrackers = async (options = {}) => {
    many = await sdk.openTrackers({
      ...options, interval: 60_000,
      notify: async (trackers) => {
        if (failSave && trackers.some(({ data }) => data.state === "sending")) throw new Error("storage unavailable");
        await options.notify?.(trackers);
      },
    });
    return many;
  };
  const { openCheckoutTrackers } = await import("../../../../walletless-checkout/tracker");
  const options = { node_url: "http://node", primary_address, view_key: "secret" };
  let tracker = await openCheckoutTrackers(options, open);
  const saved = async () => (await db.getCheckoutSessionBySessionId(row.session_id))[0];
  const state = async () => JSON.parse((await saved()).tracker_state!) as TransactionTrackerState;
  const payment = (hex: string, amount = "100000000000") => scans.set(hex, {
    tx_hash: hex.repeat(64), unlock_time: "0", outputs: [{ amount, payment_id: String(row.id), index_in_transaction: 0, stealth_address: "c".repeat(64), subaddress_index: null }],
  });
  const handover = async (hex: string) => tracker.handoverRequest(new Request("http://checkout/handover", { method: "POST", body: JSON.stringify({ tx_as_hex: hex }) }), await saved());
  return {
    row, calls, scan, payment, handover, saved, state, tracker,
    mine: (hash?: string) => { top++; if (hash) payments.set(top, hash); },
    nodeDown: (down: boolean) => { nodeDown = down; },
    restart: async () => { await tracker.stop(); tracker = await openCheckoutTrackers(options, open); },
    current: () => tracker, many: () => many,
    inspect: async (extra = {}) => {
      await Bun.write(`${directory}/result.json`, JSON.stringify({ row: await saved(), calls, ...extra }, null, 2));
      await tracker.stop();
    },
  };
}

test("the walletless handover gives the tracker the age of the invoice", async () => {
  const t = await setup("invoice-age");
  t.payment("a");
  const created = spyOn(t.many(), "new");
  await t.handover("a");
  // a payment cannot be older than its invoice, so the search starts at the block of that time
  expect(created.mock.calls[0]![0]).toMatchObject({ created_at: Date.parse(`${t.row.timestamp.replace(" ", "T")}Z`) });
  await t.inspect({ rowTimestamp: t.row.timestamp });
});

test("walletless handover saves sending before node I/O and reports the pending receipt", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const t = await setup("pending-receipt", async () => { entered.resolve(); await release.promise; return accepted; });
  t.payment("a");
  const submitting = t.handover("a");
  await entered.promise;
  expect(await t.state()).toMatchObject({ state: "sending", tx_hash: "a".repeat(64), tx_as_hex: "a" });
  expect(t.tracker.status(await t.saved())).toBe("Transaction is valid & amount correct.");
  release.resolve();
  expect(await (await submitting).json()).toEqual({ ok: true, tx_hash: "a".repeat(64) });
  expect(await t.state()).toMatchObject({ state: "accepted", merchant_confirmations: 3 });
  expect(t.tracker.status(await t.saved())).toBe("Transaction accepted by node. Waiting for a block (0/3 confirmations)");
  await t.inspect();
});

test("walletless handovers serialize scan and send for one session", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const t = await setup("concurrent-handover", async () => { entered.resolve(); await release.promise; return accepted; });
  t.payment("a"); t.payment("b");
  const first = t.handover("a");
  await entered.promise;
  const replacement = t.handover("b");
  const duplicate = t.handover("A");
  release.resolve();
  expect(await (await first).json()).toMatchObject({ ok: true, tx_hash: "a".repeat(64) });
  expect(await (await replacement).json()).toMatchObject({ ok: false });
  expect(await (await duplicate).json()).toMatchObject({ ok: true, tx_hash: "a".repeat(64) });
  expect(t.calls).toEqual(["a"]);
  expect(t.scan).toHaveBeenCalledTimes(1);
  expect((await t.saved()).tx_hash).toBe("a".repeat(64));
  await t.inspect();
});

test("walletless status shows node acceptance without claiming pool knowledge", async () => {
  const t = await setup("accepted-status");
  t.payment("a");
  await t.handover("a");
  const status = t.current().status(await t.saved());
  await t.inspect({ status });
  expect(status).toBe("Transaction accepted by node. Waiting for a block (0/3 confirmations)");
});

test("an unknown send result survives restart and cannot be replaced", async () => {
  const t = await setup("unknown-result", async () => { throw new Error("connection lost"); });
  t.payment("a", "100000000001"); t.payment("b");
  expect(await (await t.handover("a")).json()).toMatchObject({ ok: false, error: "connection lost" });
  const before = await t.state();
  expect(before).toMatchObject({ state: "sending", received_amount: "100000000001" });
  await t.restart();
  expect(await t.state()).toEqual(before);
  const restored = t.many().transactionTrackers.find(({ data }) => data.payment_id === t.row.id);
  expect(restored?.transaction.amount).toBe(100000000001n);
  expect(t.current().status(await t.saved())).toBe("Transaction is valid & amount correct.");
  expect(await (await t.handover("b")).json()).toMatchObject({ ok: false });
  expect(t.calls).toEqual(["a"]);
  await t.inspect({ restored: before });
});

test("a bad scan creates no tracker and a rejected send can retry the same bytes after restart", async () => {
  let rejectOnce = true;
  const t = await setup("node-rejection", async () => {
    if (!rejectOnce) return accepted;
    rejectOnce = false;
    return { status: "Failed", reason: "rejected", double_spend: false };
  });
  t.payment("a");
  t.payment("b");

  const before = t.many().transactionTrackers;
  expect(await (await t.handover("bad")).json()).toMatchObject({ ok: false });
  expect(t.many().transactionTrackers).toEqual(before);
  expect((await t.saved()).tx_hash).toBeNull();
  expect(t.calls).toEqual([]);

  expect(await (await t.handover("a")).json()).toMatchObject({ ok: false, error: "rejected" });
  const saved = await t.state();
  expect(saved).toMatchObject({ state: "scanned", confirmations: 0, tx_as_hex: "a", tx_hash: "a".repeat(64) });
  await t.restart();
  expect(t.many().transactionTrackers.find(tracker => tracker.data.payment_id === t.row.id)?.data).toEqual(saved);
  expect(await (await t.handover("b")).json()).toMatchObject({ ok: false });
  expect(await (await t.handover("a")).json()).toEqual({ ok: true, tx_hash: "a".repeat(64) });
  expect(t.calls).toEqual(["a", "a"]);
  await t.inspect();
});

test("two sessions with one transaction hash retain their own required counts", async () => {
  const t = await setup("shared-hash");
  const hash = t.row.id.toString(16).padStart(64, "0");
  const second = (await db.createCheckoutSession("0.2", crypto.randomUUID(), 7))[0];
  await db.saveCheckoutTrackers([t.row, second].map(row => ({
    id: row.id,
    data: {
      primary_address, payment_id: row.id, tx_hash: hash, search_from_height: 10,
      state: "accepted", confirmations: 0, merchant_confirmations: row.required_confirmations, timestamp: 1000,
    },
  })));
  await t.restart();
  const restored = t.many().transactionTrackers.filter((tracker) => tracker.data.tx_hash === hash).map((tracker) => tracker.data);
  expect(restored).toHaveLength(2);
  expect(restored.map((data) => data.merchant_confirmations).sort()).toEqual([3, 7]);
  expect(restored.every((data) => data.state === "accepted")).toBe(true);
  await t.inspect({ restoredRows: restored });
});

test("a failed state write prevents broadcast", async () => {
  const t = await setup("storage-failure", undefined, true);
  t.payment("a");
  expect(await (await t.handover("a")).json()).toMatchObject({ ok: false, error: "storage unavailable" });
  expect(t.calls).toEqual([]);
  expect((await t.saved()).tracker_state).toBeNull();
  await t.inspect();
});

test("the walletless route rejects unknown sessions and invalid requests without broadcast", async () => {
  const t = await setup("request-validation");
  expect((await t.tracker.handoverRequest(new Request("http://checkout"), undefined)).status).toBe(404);
  expect((await t.tracker.handoverRequest(new Request("http://checkout"), await t.saved())).status).toBe(405);
  for (const body of ["{", "{}", JSON.stringify({ tx_as_hex: 12 }), " ".repeat(2_010_001)]) {
    expect(await (await t.tracker.handoverRequest(new Request("http://checkout", { method: "POST", body }), await t.saved())).json()).toMatchObject({ ok: false });
  }
  t.payment("a", "1");
  expect(await (await t.handover("a")).json()).toMatchObject({ ok: false, error: "payment is below the invoice amount" });
  expect(t.calls).toEqual([]);
  expect((await t.saved()).tx_hash).toBeNull();
  await t.inspect();
});

test("a confirmed checkout releases its tracker and a later handover does not broadcast", async () => {
  const t = await setup("completed-tracker");
  t.payment("a");
  await t.handover("a");
  const finished = t.many().transactionTrackers.find((tracker) => tracker.data.payment_id === t.row.id)!;
  t.mine("a".repeat(64));
  t.mine();
  t.mine();
  await t.many().track();
  await Bun.sleep(10);
  await Bun.write(resolve("test-data/walletless-tracker/completed-tracker/completion.json"), JSON.stringify({ row: await t.saved(), retained: t.many().transactionTrackers.includes(finished) }));
  expect(t.many().transactionTrackers).not.toContain(finished);
  expect((await t.saved()).paid_status).toBe(1);
  expect(await (await t.handover("bad")).json()).toMatchObject({ ok: false });
  expect(t.many().transactionTrackers.some(tracker => tracker.data.payment_id === t.row.id)).toBe(false);
  expect(await (await t.handover("a")).json()).toMatchObject({ ok: true, tx_hash: "a".repeat(64) });
  expect(t.many().transactionTrackers.some(tracker => tracker.data.payment_id === t.row.id)).toBe(false);
  expect(t.calls).toEqual(["a"]);
  await t.inspect();
});

test("a wallet-scanned paid checkout verifies a repeat handover without starting a tracker", async () => {
  const t = await setup("paid-wallet-scan");
  t.payment("a");
  t.payment("b");
  const tx_hash = "a".repeat(64);
  await db.updateTxHash(t.row.id, tx_hash);
  await db.updateTransactionStatus(t.row.id, tx_hash, {
    in_pool: false, confirmations: 3, block_height: 10, block_hash: "block10",
  });
  expect(await t.saved()).toMatchObject({ paid_status: 1, tracker_state: null });
  expect(await (await t.handover("a")).json()).toEqual({ ok: true, tx_hash });
  expect(await (await t.handover("b")).json()).toMatchObject({ ok: false });
  expect(t.many().transactionTrackers.some(({ data }) => data.payment_id === t.row.id)).toBe(false);
  expect(t.calls).toEqual([]);
  await t.inspect();
});

test("confirmation during a handover waits for the send before tracker release", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const t = await setup("confirmation-during-send", async () => { entered.resolve(); await release.promise; return accepted; });
  t.payment("a");
  const first = t.handover("a");
  await entered.promise;
  const active = t.many().transactionTrackers.find((tracker) => tracker.data.payment_id === t.row.id)!;
  t.mine("a".repeat(64));
  t.mine();
  t.mine();
  await t.many().track();
  expect(active.data.state).toBe("confirmed");
  expect(t.many().transactionTrackers).toContain(active);
  const duplicate = t.handover("a");
  release.resolve();
  expect(await (await first).json()).toMatchObject({ ok: true });
  expect(await (await duplicate).json()).toMatchObject({ ok: true });
  expect(t.many().transactionTrackers).not.toContain(active);
  expect(t.calls).toEqual(["a"]);
  await t.inspect();
});


test("a checkout status refresh catches up after a failed tick", async () => {
  const t = await setup("status-refresh");
  t.payment("a");
  await t.handover("a");
  const accepted = await t.saved();
  t.nodeDown(true);
  expect((await t.tracker.refresh(accepted)).tx_confirmations).toBe(0);
  t.nodeDown(false);
  t.mine("a".repeat(64));
  const current = await t.tracker.refresh(accepted);
  expect(current.tx_confirmations).toBe(1);
  expect(await t.state()).toMatchObject({ state: "in_block", confirmations: 1 });
  await t.inspect({ confirmations: current.tx_confirmations });
});
