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

const OUT = "test-data/locked-input-second-send";

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

test("a successful send keeps the input locked for a second send", async () => {
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
    wallet_name: "lock",
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
  await Bun.write(
    `${OUT}/${address}_cache.json`,
    JSON.stringify(
      {
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
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  );

  const many = await openWallets({
    scan_settings_path: settingsPath,
    no_worker: true,
    actionLogPath: ":memory:",
  });
  const wallet = many!.wallets[0]!;
  const feeEstimate = { status: "OK", fee: 1, quantization_mask: 1, fees: [1] };
  const stubSelect = async () => {
    const selectedInputs = wallet.selectInputs(1_000_000_000_000n, 1n);
    if (!selectedInputs.length) throw new Error("not enough funds");
    return { selectedInputs, feeEstimate };
  };
  wallet.calculateFeeAndSelectInputs = stubSelect;
  wallet.makeTransactionFromSelectedInputs = async () => "unsigned";
  wallet.signTransaction = async () => "signed";
  wallet.sendTransaction = async () => okSend();
  await wallet.makeSignSendTransaction({
    payments: [{ address: "dest", amount: "1000000000000" }],
    invocationId: "inv-1",
  });
  expect(wallet.spendableInputs().map((o) => o.index_on_blockchain)).not.toContain(7);
  await many!.stopWorker();

  const again = await openWallets({
    scan_settings_path: settingsPath,
    no_worker: true,
    actionLogPath: ":memory:",
  });
  const wallet2 = again!.wallets[0]!;
  expect(wallet2.spendableInputs().map((o) => o.index_on_blockchain)).not.toContain(7);
  let secondNodeCall = false;
  wallet2.calculateFeeAndSelectInputs = async () => {
    const selectedInputs = wallet2.selectInputs(1_000_000_000_000n, 1n);
    if (!selectedInputs.length) throw new Error("not enough funds");
    return { selectedInputs, feeEstimate };
  };
  wallet2.makeTransactionFromSelectedInputs = async () => "unsigned";
  wallet2.signTransaction = async () => "signed";
  wallet2.sendTransaction = async () => {
    secondNodeCall = true;
    return okSend();
  };
  await expect(
    wallet2.makeSignSendTransaction({
      payments: [{ address: "dest", amount: "1000000000000" }],
      invocationId: "inv-2",
    }),
  ).rejects.toThrow("not enough funds");
  expect(secondNodeCall).toBe(false);
  await again!.stopWorker();
});
