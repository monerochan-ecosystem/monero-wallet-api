import { test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  openWallets,
  writeScanSettings,
  ScanSettingsOpened,
  makeTestKeyPair,
} from "../../../dist/api";

const OUT = "test-data/many-empty-state";

beforeEach(async () => {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
});

test("openWallets with zero wallets returns Many with empty list, no throw", async () => {
  const path = `${OUT}/ScanSettings.json`;
  await writeScanSettings(
    { wallets: [], node_url: "http://127.0.0.1:18081", start_height: null },
    path,
  );

  const many = await openWallets({ scan_settings_path: path });

  expect(many).toBeDefined();
  expect(many!.wallets.length).toBe(0);
  expect(() => many!.stopWorker()).not.toThrow();
  await many!.buildWallets();
  expect(many!.wallets.length).toBe(0);
});

test("remove last wallet stops worker then leaves empty without throw or restart", async () => {
  const path = `${OUT}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  const kp = await makeTestKeyPair();
  const addr = kp.view_key.mainnet_primary;
  Bun.env[`vk${addr}`] = kp.view_key.view_key;

  await sso.addViewWallet(addr, kp.view_key.view_key, { wallet_name: "only" });

  // open with no_worker so we exercise the many without starting fetch workers
  const many = await openWallets({
    scan_settings_path: path,
    no_worker: true,
  });

  expect(many).toBeDefined();
  expect(many!.wallets.length).toBe(1);

  // remove the only wallet must stop first, then not throw, end up empty
  await many!.removeWallet(addr);
  expect(many!.wallets.length).toBe(0);

  // further build must stay empty and not throw
  await many!.buildWallets();
  expect(many!.wallets.length).toBe(0);
});
