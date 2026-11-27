import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import * as api from "../../../dist/xmr3";

const START = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(START); });
afterEach(() => { jest.useRealTimers(); });
function fixture() {
  return {
    primary_address: "payer", daemon_height: 101, scanned_ranges: [], own_key_images: {},
    outputs: { "7": { index_on_blockchain: 7, block_height: 1, amount: 100n, tx_hash: "received", is_miner_tx: false } },
    tx_logs: [{ inputs_index: ["7"], payments: [{ address: "merchant", amount: "30" }], node_url: "node", height: 100, timestamp: START, signed_tx: "same-bytes", last_broadcast_at: START, error: "timeout" }],
    pending_spent_utxos: { "7": 0 },
  } as unknown as api.ScanCache;
}
function totals(cache: api.ScanCache) {
  const stats = { primary_address: "payer", height: 100, subaddresses: {}, found_transactions: {}, ordered_transactions: [], total_spendable_amount: 0n, total_pending_amount: 0n } as api.ScanStats;
  api.processFoundTransactions(cache, stats, 100);
  api.processTxlogs(cache, stats);
  return stats;
}

test("time does not unlock a failed broadcast after timeout or node rejection", () => {
  for (const sendResult of [undefined, { status: "Failed", reason: "double spend" }]) {
    const cache = fixture();
    cache.tx_logs![0]!.sendResult = sendResult as any;
    expect(api.outputStatus(cache.outputs["7"]!, cache, 100).status).toBe("prepending");
    expect(totals(cache).total_spendable_amount).toBe(0n);
    expect(totals(cache).total_pending_amount).toBe(100n);
    jest.setSystemTime(START + DAY);
    expect(api.isInputLocked(cache, "7")).toBe(true);
    expect(api.outputStatus(cache.outputs["7"]!, cache, 100).status).toBe("prepending");
    expect(totals(cache).total_spendable_amount).toBe(0n);
    expect(totals(cache).total_pending_amount).toBe(100n);
    jest.setSystemTime(START);
  }
});

test("a new send requires release and counts its own reservation only", () => {
  const cache = fixture();
  const next = { primary_address: "payer", txLog: { inputs_index: ["7"], payments: [{ address: "next", amount: "40" }], node_url: "node", timestamp: START, height: 100 } };
  expect(() => api.applyTxCacheWrite(cache, next)).toThrow("input not spendable");
  jest.setSystemTime(START + DAY);
  expect(() => api.applyTxCacheWrite(cache, next)).toThrow("input not spendable");
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, releaseInputs: true });
  expect(api.applyTxCacheWrite(cache, next)).toBe(1);
  expect(cache.pending_spent_utxos!["7"]).toBe(1);
  expect(totals(cache).total_spendable_amount).toBe(0n);
  expect(totals(cache).total_pending_amount).toBe(60n);
  // a late answer for the old attempt must not release the new reservation.
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, txLog: { error: "late reply" } });
  expect(cache.pending_spent_utxos!["7"]).toBe(1);
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("retry updates the broadcast time and the reservation does not expire", () => {
  const cache = fixture();
  jest.setSystemTime(START + DAY);
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true });
  expect(cache.tx_logs![0]!.last_broadcast_at).toBe(START + DAY);
  jest.setSystemTime(START + 2 * DAY);
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("scan-spent wins over pending reservations and never unlocks on time", () => {
  const cache = fixture();
  cache.outputs["7"]!.spent_in_tx_hash = "mined";
  expect(api.outputStatus(cache.outputs["7"]!, cache, 100).status).toBe("spent");
  jest.setSystemTime(START + DAY);
  expect(api.outputStatus(cache.outputs["7"]!, cache, 100).status).toBe("spent");
  expect(totals(cache).total_spendable_amount).toBe(0n);
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true })).toThrow("input not spendable");
});

test("only a completed signed draft can be released before a broadcast result", () => {
  const cache = fixture();
  const row = cache.tx_logs![0]!;
  const release = { primary_address: "payer", txLogIndex: 0, releaseInputs: true };
  delete row.error;
  row.last_broadcast_at = null;
  delete row.signed_tx;
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, release)).toThrow();

  row.signed_tx = "same-bytes";
  row.last_broadcast_at = START;
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, release)).toThrow();

  row.last_broadcast_at = null;
  expect(api.canReleaseInputs(cache, 0)).toBe(true);
  api.applyTxCacheWrite(cache, release);
  expect(cache.pending_spent_utxos).toEqual({});
  expect(cache.tx_logs![0]).toMatchObject({ signed_tx: "same-bytes", inputs_unlocked: true });
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
});

test("released failed inputs can be reserved again for the same bytes", () => {
  const cache = fixture();
  expect(api.canReleaseInputs(cache, 0)).toBe(true);
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, releaseInputs: true });
  expect(cache.pending_spent_utxos).toEqual({});
  expect(api.isInputLocked(cache, "7")).toBe(false);
  expect(cache.tx_logs![0]!.error).toBe("timeout");
  expect(cache.tx_logs![0]!.signed_tx).toBe("same-bytes");
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true });
  expect(api.isInputLocked(cache, "7")).toBe(true);
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, txLog: { error: undefined, sendResult: { status: "OK" } as any } });
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, releaseInputs: true })).toThrow();
});

test("signing failures and finalized legacy failures keep their release behavior", () => {
  for (const last_broadcast_at of [null, undefined]) {
    const cache = fixture();
    cache.tx_logs![0]!.last_broadcast_at = last_broadcast_at;
    expect(api.isInputLocked(cache, "7")).toBe(false);
    api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, txLog: { error: "signing failed", signed_tx: undefined } });
    expect(cache.pending_spent_utxos!["7"]).toBeUndefined();
  }
});

test("a new pending transaction log row reserves its inputs without a separate flag", () => {
  const cache = fixture();
  cache.pending_spent_utxos = {};
  cache.tx_logs![0]!.inputs_unlocked = true;
  const index = api.applyTxCacheWrite(cache, {
    primary_address: "payer",
    txLog: { ...cache.tx_logs![0], error: undefined, signed_tx: undefined, last_broadcast_at: null, inputs_unlocked: false },
  });
  expect(cache.pending_spent_utxos!["7"]).toBe(index);
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("merchant acceptance keeps the input locked when the payer node fails", () => {
  const cache = fixture();
  api.applyTxCacheWrite(cache, {
    primary_address: "payer", txLogIndex: 0,
    txLog: { broadcast_accepted: true },
  });
  jest.setSystemTime(START + DAY);
  expect(api.isInputLocked(cache, "7")).toBe(true);
  expect(api.outputStatus(cache.outputs["7"]!, cache, 100).status).toBe("prepending");
});

test("a failed rebroadcast does not erase earlier node acceptance", () => {
  const cache = fixture();
  cache.tx_logs![0]!.sendResult = { status: "OK" } as api.SendRawTransactionResult;
  api.applyTxCacheWrite(cache, {
    primary_address: "payer", txLogIndex: 0, broadcast: true,
    txLog: { sendResult: undefined, error: undefined },
  });
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, txLog: { error: "node offline" } });
  jest.setSystemTime(START + DAY);
  expect(api.txFailed(cache.tx_logs![0]!)).toBe(false);
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("restart keeps inputs locked for an interrupted draft or broadcast", () => {
  const cache = fixture();
  const broadcast = cache.tx_logs![0]!;
  delete broadcast.error;
  cache.outputs["8"] = { ...cache.outputs["7"]!, index_on_blockchain: 8 };
  cache.outputs["9"] = { ...cache.outputs["7"]!, index_on_blockchain: 9 };
  cache.tx_logs!.push({ ...broadcast, inputs_index: ["8"], last_broadcast_at: null });
  cache.pending_spent_utxos!["8"] = 1;
  cache.tx_logs!.push({ ...broadcast, inputs_index: ["9"], signed_tx: undefined, last_broadcast_at: null });
  cache.pending_spent_utxos!["9"] = 2;
  expect(api.recoverInterruptedSends(cache)).toBe(true);
  expect(api.isInputLocked(cache, "7")).toBe(true);
  expect(api.isInputLocked(cache, "8")).toBe(true);
  expect(api.isInputLocked(cache, "9")).toBe(true);
  expect(cache.tx_logs![0]!.signed_tx).toBe("same-bytes");
  expect(api.txFailed(cache.tx_logs![0]!)).toBe(true);
  jest.setSystemTime(START + DAY);
  expect(api.isInputLocked(cache, "7")).toBe(true);
  expect(api.recoverInterruptedSends(cache)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 2, broadcast: true })).toThrow("signed transaction required");
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 2, releaseInputs: true });
  expect(api.isInputLocked(cache, "9")).toBe(false);
});

test("merchant acceptance prevents release even after a payer node error", () => {
  const cache = fixture();
  cache.tx_logs![0]!.broadcast_accepted = true;
  expect(api.canReleaseInputs(cache, 0)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, releaseInputs: true })).toThrow();
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("restart keeps an older interrupted draft locked until manual release", () => {
  const cache = fixture();
  const row = cache.tx_logs![0]!;
  row.last_broadcast_at = null;
  row.error = "send interrupted before broadcast";
  expect(api.recoverInterruptedSends(cache)).toBe(true);
  expect(api.isInputLocked(cache, "7")).toBe(true);
  api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, releaseInputs: true });
  expect(api.recoverInterruptedSends(cache)).toBe(false);
  expect(api.isInputLocked(cache, "7")).toBe(false);
});

test("an interrupted legacy send with a reservation stays locked on restart", () => {
  const cache = fixture();
  const row = cache.tx_logs![0]!;
  delete row.error;
  delete row.signed_tx;
  delete row.last_broadcast_at;
  jest.setSystemTime(START + DAY * 2);
  expect(api.recoverInterruptedSends(cache)).toBe(true);
  expect(api.isInputLocked(cache, "7")).toBe(true);
  jest.setSystemTime(START + DAY * 3);
  expect(api.recoverInterruptedSends(cache)).toBe(false);
  expect(api.isInputLocked(cache, "7")).toBe(true);
});

test("late merchant acceptance locks previously released inputs before a new draft can send", () => {
  const cache = fixture();
  const address = { primary_address: "payer" };
  api.applyTxCacheWrite(cache, { ...address, txLogIndex: 0, releaseInputs: true });
  const index = api.applyTxCacheWrite(cache, { ...address, txLog: {
    inputs_index: ["7"], payments: [], node_url: "node", timestamp: START, height: 100, signed_tx: "other-bytes",
  } });
  api.applyTxCacheWrite(cache, { ...address, txLogIndex: 0, txLog: { broadcast_accepted: true } });
  expect(api.txLogHoldsFunds(cache.tx_logs![0]!)).toBe(true);
  expect(cache.pending_spent_utxos!["7"]).toBe(0);
  expect(api.canRebroadcastTx(cache, index)).toBe(false);
  expect(api.canReleaseInputs(cache, index)).toBe(false);
  expect(() => api.applyTxCacheWrite(cache, { ...address, txLogIndex: index, broadcast: true })).toThrow("input not spendable");
});

// the scan can mark the inputs spent after a renewal read them. so the write decides.
test("a renewal with the hash of the transaction that spent the inputs needs no lock", () => {
  const cache = fixture();
  cache.outputs["7"]!.spent_in_tx_hash = "own";
  const row = structuredClone(cache.tx_logs![0]);
  expect(api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true, tx_hash: "own" })).toBe(0);
  expect(cache.tx_logs![0]).toEqual(row);
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true, tx_hash: "other" })).toThrow("input not spendable");
  expect(() => api.applyTxCacheWrite(cache, { primary_address: "payer", txLogIndex: 0, broadcast: true })).toThrow("input not spendable");
});
