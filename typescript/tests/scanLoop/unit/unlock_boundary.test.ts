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
