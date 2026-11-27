import { expect, test } from "bun:test";
import { outputStatus, type Output, type ScanCache } from "../../../dist/xmr3";

// monerod counts blocks (top index + 1). an output in block 100 can be spent
// in block 110, so it is spendable once the scanned top block index is 109.
const cache = { outputs: {}, pending_spent_utxos: {} } as unknown as ScanCache;
function output(is_miner_tx: boolean) {
  return { block_height: 100, index_on_blockchain: 7, is_miner_tx } as Output;
}

test("normal output unlocks at top index block_height + 9", () => {
  expect(outputStatus(output(false), cache, 108)).toEqual({
    status: "pending",
    unlock_height: 110,
  });
  expect(outputStatus(output(false), cache, 109)).toEqual({
    status: "spendable",
  });
});

test("coinbase output unlocks at top index block_height + 59", () => {
  expect(outputStatus(output(true), cache, 158)).toEqual({
    status: "pending",
    unlock_height: 160,
  });
  expect(outputStatus(output(true), cache, 159)).toEqual({
    status: "spendable",
  });
});

test("a reserved input is never spendable. a mined or burnt one is not prepending", () => {
  // tx log index 0 is a real lock. 0 must not count as missing.
  const reserved = {
    outputs: {}, pending_spent_utxos: { "7": 0 },
    tx_logs: [{ inputs_index: ["7"], last_broadcast_at: null, signed_tx: "aa" }],
  } as unknown as ScanCache;
  expect(outputStatus(output(false), reserved, 109)).toEqual({ status: "prepending" });
  // burnt and spent are on-chain facts. they win over the lock
  expect(outputStatus({ ...output(false), spent_in_tx_hash: "mined" }, reserved, 109)).toEqual({ status: "spent" });
  expect(outputStatus({ ...output(false), burned: 1 }, reserved, 109)).toEqual({ status: "burnt" });
  // a released draft holds no funds, so its entry is not a lock
  const released = { ...reserved, tx_logs: [{ ...reserved.tx_logs[0], inputs_unlocked: true }] } as unknown as ScanCache;
  expect(outputStatus(output(false), released, 109)).toEqual({ status: "spendable" });
});
