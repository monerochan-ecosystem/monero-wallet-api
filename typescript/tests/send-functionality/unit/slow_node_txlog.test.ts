import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  makeTestKeyPair,
  openWallets,
  ScanSettingsOpened,
  writeScanSettings,
  type Output,
  type SendRawTransactionResult,
} from "../../../dist/xmr3";

const OUT = "test-data/slow-node-txlog";

async function readCache(address: string) {
  const text = await Bun.file(`${OUT}/${address}_cache.json`).text();
  return JSON.parse(text, (key, value) =>
    key === "amount" ? BigInt(value) : value,
  ) as {
    tx_logs?: {
      sendResult?: { status?: string };
      signed_tx?: string;
      invocationId?: string;
    }[];
    pending_spent_utxos?: Record<string, number>;
  };
}

function okSend(): SendRawTransactionResult {
  return {
    double_spend: false,
    fee_too_low: false,
    invalid_input: false,
    invalid_output: false,
    low_mixin: false,
    not_relayed: false,
    overspend: false,
    reason: "",
    status: "OK",
    too_big: false,
    untrusted: false,
  };
}

test("a slow node answer updates the same tx log row", async () => {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
  const settingsPath = `${OUT}/ScanSettings.json`;
  await writeScanSettings(
    { wallets: [], node_url: "http://127.0.0.1:9", start_height: 0 },
    settingsPath,
  );
  const kp = await makeTestKeyPair();
  const address = kp.view_key.mainnet_primary;
  Bun.env[`vk${address}`] = kp.view_key.view_key;
  Bun.env[`sk${address}`] = kp.spend_key;
  const settings = await ScanSettingsOpened.create(settingsPath);
  await settings.addViewWallet(address, kp.view_key.view_key, {
    wallet_name: "slow",
  });
  const output = {
    amount: 5_000_000_000_000n,
    block_height: 1,
    block_timestamp: 1,
    index_in_transaction: 0,
    index_on_blockchain: 7,
    payment_id: 0,
    stealth_address: "stealth",
    tx_hash: "tx",
    is_miner_tx: false,
    primary_address: address,
    subaddress_index: null,
    serialized: "00",
  } as Output;
  const cache = {
    daemon_height: 50,
    primary_address: address,
    outputs: { "7": output },
    own_key_images: {},
    scanned_ranges: [
      {
        start: 0,
        end: 50,
        block_hashes: [
          { block_hash: "aa", block_height: 0, block_timestamp: 1 },
          { block_hash: "bb", block_height: 50, block_timestamp: 1 },
          { block_hash: "bb", block_height: 50, block_timestamp: 1 },
        ],
      },
    ],
    tx_logs: [],
    pending_spent_utxos: {},
  };
  await Bun.write(
    `${OUT}/${address}_cache.json`,
    JSON.stringify(cache, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  const many = await openWallets({
    scan_settings_path: settingsPath,
    no_worker: true,
    actionLogPath: ":memory:",
  });
  const wallet = many!.wallets[0]!;
  wallet.calculateFeeAndSelectInputs = async () => ({
    selectedInputs: [output],
    feeEstimate: { status: "OK", fee: 1, quantization_mask: 1, fees: [1] },
  });
  wallet.makeTransactionFromSelectedInputs = async () => "unsigned";
  wallet.signTransaction = async () => "signed";
  let release: (result: SendRawTransactionResult) => void = () => {};
  const gate = new Promise<SendRawTransactionResult>((resolve) => {
    release = resolve;
  });
  let nodeEntered = false;
  wallet.sendTransaction = async () => {
    nodeEntered = true;
    return await gate;
  };
  const pending = wallet.makeSignSendTransaction({
    payments: [{ address: "dest", amount: "1000000000000" }],
    invocationId: "inv-slow",
  });
  const deadline = Date.now() + 5000;
  while (!nodeEntered && Date.now() < deadline) await Bun.sleep(10);
  expect(nodeEntered).toBe(true);
  const mid = await readCache(address);
  expect(mid?.tx_logs?.length).toBe(1);
  expect(mid?.tx_logs?.[0]?.sendResult).toBeUndefined();
  expect(mid?.tx_logs?.[0]?.invocationId).toBe("inv-slow");
  expect(mid?.pending_spent_utxos?.["7"]).toBe(0);
  release(okSend());
  const sent = await pending;
  expect(sent.status).toBe("OK");
  const after = await readCache(address);
  expect(after?.tx_logs?.length).toBe(1);
  expect(after?.tx_logs?.[0]?.sendResult?.status).toBe("OK");
  expect(after?.tx_logs?.[0]?.signed_tx).toBe("signed");
  expect(after?.pending_spent_utxos?.["7"]).toBe(0);
  await many!.stopWorker();
});
