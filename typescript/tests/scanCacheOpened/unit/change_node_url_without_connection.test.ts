/**
 * save must store the node url even when nothing is connected.
 * no monerod. no wasm. no workers.
 */
import { test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { openWallets } from "../../../wallet-api/scanning-syncing/openWallet";
import {
  openScanSettingsFile,
  writeScanSettings,
} from "../../../wallet-api/scansettings/scanSettings";

const OUT = "test-data/change-node-without-connection";
const OLD = "http://127.0.0.1:18081";
const NEXT = "https://node.monero.fail";

beforeEach(async () => {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
});

async function settingsWithNoWallet(name: string) {
  const path = `${OUT}/${name}`;
  await writeScanSettings(
    { wallets: [], node_url: OLD, start_height: null },
    path,
  );
  return path;
}

test("ui save fails when the background does not answer", async () => {
  const path = await settingsWithNoWallet("ScanSettings.json");
  const many = await openWallets({
    scan_settings_path: path,
    extensionMessageBus: "ui",
    no_worker: true,
  });

  await expect(many!.changeNodeUrlAndStartHeight(NEXT, 0)).rejects.toThrow(
    "background did not save the node url",
  );

  const raw = await openScanSettingsFile(path);
  expect(raw?.node_url).toBe(OLD);
});

test("worker save stores the url when no wallet ever connected", async () => {
  const path = await settingsWithNoWallet("worker.json");
  const many = await openWallets({
    scan_settings_path: path,
    extensionMessageBus: "worker",
    no_worker: true,
  });

  await many!.changeNodeUrlAndStartHeight(NEXT, null);

  const raw = await openScanSettingsFile(path);
  expect(raw?.node_url).toBe(NEXT);
  expect(raw?.start_height).toBe(null);
});
