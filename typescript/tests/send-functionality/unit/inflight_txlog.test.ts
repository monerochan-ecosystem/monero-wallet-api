import { expect, test } from "bun:test";
import {
  processTxlogs,
  txLogHoldsFunds,
  type ScanStats,
} from "../../../wallet-api/scanning-syncing/scanresult/scanStats";
import type { ScanCache, TxLog } from "../../../wallet-api/scanning-syncing/scanresult/scanCache";

function stats(): ScanStats {
  return {
    height: 1,
    total_spendable_amount: 0n,
    total_pending_amount: 0n,
    primary_address: "primary",
    found_transactions: {},
    ordered_transactions: [],
    subaddresses: {},
  };
}

function cache(txlog: TxLog): ScanCache {
  return {
    daemon_height: 10,
    primary_address: "primary",
    outputs: {
      "7": {
        amount: 5_000_000_000_000n,
        index_on_blockchain: 7,
      } as ScanCache["outputs"][string],
    },
    own_key_images: {},
    scanned_ranges: [],
    tx_logs: [txlog],
    pending_spent_utxos: { "7": 0 },
  };
}

const row = (extra: Partial<TxLog> = {}): TxLog => ({
  inputs_index: ["7"],
  payments: [{ address: "dest", amount: "1000000000000" }],
  node_url: "http://127.0.0.1:18081",
  height: 10,
  timestamp: 1,
  ...extra,
});

test("an in-flight tx log holds the inputs and counts as pending", () => {
  const txlog = row();
  expect(txLogHoldsFunds(txlog)).toBe(true);
  const next = stats();
  processTxlogs(cache(txlog), next);
  expect(next.total_pending_amount).toBe(4_000_000_000_000n);
  expect(next.total_spendable_amount).toBe(0n);
});

test("a failed tx log does not hold the inputs", () => {
  const txlog = row({ error: "send failed" });
  expect(txLogHoldsFunds(txlog)).toBe(false);
  const next = stats();
  processTxlogs(cache(txlog), next);
  expect(next.total_pending_amount).toBe(0n);
});

test("an ok tx log still counts as pending", () => {
  const txlog = row({
    sendResult: { status: "OK", reason: "" } as TxLog["sendResult"],
  });
  expect(txLogHoldsFunds(txlog)).toBe(true);
  const next = stats();
  processTxlogs(cache(txlog), next);
  expect(next.total_pending_amount).toBe(4_000_000_000_000n);
});
