import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  ScanSettingsOpened,
  makeTestKeyPair,
  writeScanSettings,
} from "../../../dist/api";

const OUT = "test-data/scanSettingsOpened";

async function readFile(path: string) {
  return JSON.parse(await Bun.file(path).text());
}

test("a: create with no existing file uses defaults", async () => {
  const dir = `${OUT}/a`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  expect(sso.node_url).toBe("http://127.0.0.1:18081");
  expect(sso.start_height).toBeNull();
  expect(sso.merchant_confirmations).toBeUndefined();
  expect(sso.cpu_worker_count).toBeUndefined();
  expect(sso.wallets).toEqual([]);
  expect(sso.scan_settings_path).toBe(path);

  // verify file on disk
  const raw = await readFile(path);
  expect(raw.node_url).toBe("http://127.0.0.1:18081");
  expect(raw.start_height).toBeNull();
  expect(raw.wallets).toEqual([]);
  // these keys are absent in the file when not set
  expect(raw.merchant_confirmations).toBeUndefined();
  expect(raw.cpu_worker_count).toBeUndefined();
});

test("b: settings level mutations persist to file", async () => {
  const dir = `${OUT}/b`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  // setNodeUrl
  await sso.setNodeUrl("http://node.example:18089");
  expect(sso.node_url).toBe("http://node.example:18089");
  let raw = await readFile(path);
  expect(raw.node_url).toBe("http://node.example:18089");

  // setStartHeight
  await sso.setStartHeight(500000);
  expect(sso.start_height).toBe(500000);
  raw = await readFile(path);
  expect(raw.start_height).toBe(500000);

  // setMerchantConfirmations
  await sso.setMerchantConfirmations(10);
  expect(sso.merchant_confirmations).toBe(10);
  raw = await readFile(path);
  expect(raw.merchant_confirmations).toBe(10);

  await sso.setMerchantConfirmations(null);
  expect(sso.merchant_confirmations).toBeUndefined();
  raw = await readFile(path);
  expect(raw.merchant_confirmations).toBeUndefined();

  // setCpuWorkerCount
  await sso.setCpuWorkerCount(4);
  expect(sso.cpu_worker_count).toBe(4);
  raw = await readFile(path);
  expect(raw.cpu_worker_count).toBe(4);

  // unset cpu_worker_count (pass undefined / null removes it)
  await sso.setCpuWorkerCount(undefined);
  expect(sso.cpu_worker_count).toBeUndefined();
  raw = await readFile(path);
  expect(raw.cpu_worker_count).toBeUndefined();

  // setLogSettings
  await sso.setLogSettings("file", ["coordinatorMain", "handleCpuboundScan"]);
  expect(sso.logs).toBe("file");
  expect(sso.logs_include).toEqual(["coordinatorMain", "handleCpuboundScan"]);
  raw = await readFile(path);
  expect(raw.logs).toBe("file");
  expect(raw.logs_include).toEqual(["coordinatorMain", "handleCpuboundScan"]);

  // unset log settings with null (deletes the keys from file)
  await sso.setLogSettings(null, null, null);
  expect(sso.logs).toBeUndefined();
  expect(sso.logs_include).toBeUndefined();
  expect(sso.logs_exclude).toBeUndefined();
  raw = await readFile(path);
  expect(raw.logs).toBeUndefined();
  expect(raw.logs_include).toBeUndefined();
  expect(raw.logs_exclude).toBeUndefined();
});

test("c: addViewWallet adds wallet to settings and env", async () => {
  const dir = `${OUT}/c`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  await sso.addViewWallet(kp.view_key.mainnet_primary, kp.view_key.view_key, {
    wallet_name: "test wallet",
    wallet_slot: 1,
    wallet_route: "main/no_domain/single/0",
  });

  expect(sso.wallets.length).toBe(1);
  expect(sso.walletExists(kp.view_key.mainnet_primary)).toBe(true);

  const wallet = sso.getWallet(kp.view_key.mainnet_primary);
  expect(wallet).toBeDefined();
  if (!wallet) return;
  expect(wallet.primary_address).toBe(kp.view_key.mainnet_primary);
  expect(wallet.wallet_name).toBe("test wallet");
  expect(wallet.wallet_slot).toBe(1);
  expect(wallet.wallet_route).toBe("main/no_domain/single/0");

  // env var was set
  expect(Bun.env[`vk${kp.view_key.mainnet_primary}`]).toBe(
    kp.view_key.view_key,
  );

  // getWalletOpened returns keys
  const opened = await sso.getWalletOpened(kp.view_key.mainnet_primary);
  expect(opened.secret_view_key).toBe(kp.view_key.view_key);
  expect(opened.primary_address).toBe(kp.view_key.mainnet_primary);

  // verify on disk with raw file read
  const raw = await readFile(path);
  expect(raw.wallets.length).toBe(1);
  expect(raw.wallets[0].primary_address).toBe(kp.view_key.mainnet_primary);
  expect(raw.wallets[0].wallet_name).toBe("test wallet");
  expect(raw.wallets[0].wallet_slot).toBe(1);
  expect(raw.wallets[0].wallet_route).toBe("main/no_domain/single/0");

  // duplicate throws
  await expect(
    sso.addViewWallet(kp.view_key.mainnet_primary, kp.view_key.view_key),
  ).rejects.toThrow("wallet already exists");
});

test("d: addSpendWallet generates keys and adds wallet", async () => {
  const dir = `${OUT}/d`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  // make a seed-like entropy (64 bytes)
  const entropy = new Uint8Array(64);
  crypto.getRandomValues(entropy);

  await sso.addSpendWallet(entropy, {
    wallet_name: "my spend wallet",
    wallet_slot: 0,
  });

  expect(sso.wallets.length).toBe(1);
  const wallet = sso.wallets[0];
  expect(wallet).toBeDefined();
  if (!wallet) return;
  expect(wallet.wallet_name).toBe("my spend wallet");
  expect(wallet.wallet_slot).toBe(0);

  // env vars were set for both view and spend keys
  expect(Bun.env[`vk${wallet.primary_address}`]).toBeDefined();
  expect(Bun.env[`sk${wallet.primary_address}`]).toBeDefined();

  // getWalletOpened returns both keys
  const opened = await sso.getWalletOpened(wallet.primary_address);
  expect(opened.secret_view_key).toBe(Bun.env[`vk${wallet.primary_address}`]);
  expect(opened.secret_spend_key).toBe(Bun.env[`sk${wallet.primary_address}`]);

  // verify on disk with raw file read
  const raw = await readFile(path);
  expect(raw.wallets.length).toBe(1);
  expect(raw.wallets[0].primary_address).toBe(wallet.primary_address);
  expect(raw.wallets[0].wallet_name).toBe("my spend wallet");
  expect(raw.wallets[0].wallet_slot).toBe(0);
  // view and spend keys should NOT be in the settings file, only in env
  expect(raw.wallets[0].secret_view_key).toBeUndefined();
  expect(raw.wallets[0].secret_spend_key).toBeUndefined();
});

test("e: updateWallet changes wallet fields", async () => {
  const dir = `${OUT}/e`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp.view_key.mainnet_primary, kp.view_key.view_key, {
    wallet_name: "original",
    wallet_slot: 1,
    wallet_route: "main/no_domain/single/0",
  });

  // update fields
  await sso.updateWallet(kp.view_key.mainnet_primary, {
    wallet_name: "updated",
    wallet_slot: 2,
  });
  const w = sso.getWallet(kp.view_key.mainnet_primary);
  expect(w?.wallet_name).toBe("updated");
  expect(w?.wallet_slot).toBe(2);
  expect(w?.wallet_route).toBe("main/no_domain/single/0");
  // fields not passed in the update should be untouched
  expect(w?.subaddress_index).toBe(1);
  expect(w?.halted).toBeUndefined();

  // verify on disk
  let raw = await readFile(path);
  expect(raw.wallets[0].wallet_name).toBe("updated");
  expect(raw.wallets[0].wallet_slot).toBe(2);
  expect(raw.wallets[0].wallet_route).toBe("main/no_domain/single/0");
  expect(raw.wallets[0].subaddress_index).toBe(1);
  expect(raw.wallets[0].halted).toBeUndefined();

  // unset fields with null
  await sso.updateWallet(kp.view_key.mainnet_primary, {
    wallet_name: null,
    wallet_slot: null,
  });
  const w2 = sso.getWallet(kp.view_key.mainnet_primary);
  expect(w2?.wallet_name).toBeUndefined();
  expect(w2?.wallet_slot).toBeUndefined();
  expect(w2?.wallet_route).toBe("main/no_domain/single/0");

  // verify on disk
  raw = await readFile(path);
  expect(raw.wallets[0].wallet_name).toBeUndefined();
  expect(raw.wallets[0].wallet_slot).toBeUndefined();
  expect(raw.wallets[0].wallet_route).toBe("main/no_domain/single/0");
});

test("f: halt and unhalt wallet", async () => {
  const dir = `${OUT}/f`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp.view_key.mainnet_primary, kp.view_key.view_key);

  expect(sso.getWallet(kp.view_key.mainnet_primary)?.halted).toBeUndefined();
  let raw = await readFile(path);
  expect(raw.wallets[0].halted).toBeUndefined();

  await sso.haltWallet(kp.view_key.mainnet_primary);
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.halted).toBe(true);
  raw = await readFile(path);
  expect(raw.wallets[0].halted).toBe(true);

  await sso.unhaltWallet(kp.view_key.mainnet_primary);
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.halted).toBe(false);
  raw = await readFile(path);
  expect(raw.wallets[0].halted).toBe(false);
});

test("g: convenience setters for wallet fields", async () => {
  const dir = `${OUT}/g`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp.view_key.mainnet_primary, kp.view_key.view_key);

  await sso.setWalletName(kp.view_key.mainnet_primary, "renamed");
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.wallet_name).toBe(
    "renamed",
  );
  let raw = await readFile(path);
  expect(raw.wallets[0].wallet_name).toBe("renamed");

  await sso.setWalletSlot(kp.view_key.mainnet_primary, 5);
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.wallet_slot).toBe(5);
  raw = await readFile(path);
  expect(raw.wallets[0].wallet_slot).toBe(5);

  await sso.setWalletRoute(kp.view_key.mainnet_primary, "custom/route/0");
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.wallet_route).toBe(
    "custom/route/0",
  );
  raw = await readFile(path);
  expect(raw.wallets[0].wallet_route).toBe("custom/route/0");

  await sso.setSubaddressIndex(kp.view_key.mainnet_primary, 3);
  expect(sso.getWallet(kp.view_key.mainnet_primary)?.subaddress_index).toBe(3);
  raw = await readFile(path);
  expect(raw.wallets[0].subaddress_index).toBe(3);

  // unset
  await sso.setWalletName(kp.view_key.mainnet_primary, undefined);
  expect(
    sso.getWallet(kp.view_key.mainnet_primary)?.wallet_name,
  ).toBeUndefined();
  raw = await readFile(path);
  expect(raw.wallets[0].wallet_name).toBeUndefined();
});

test("h: removeWallet removes from settings", async () => {
  const dir = `${OUT}/h`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp1 = await makeTestKeyPair();
  const kp2 = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  await sso.addViewWallet(kp1.view_key.mainnet_primary, kp1.view_key.view_key);
  await sso.addViewWallet(kp2.view_key.mainnet_primary, kp2.view_key.view_key);
  expect(sso.wallets.length).toBe(2);
  let raw = await readFile(path);
  expect(raw.wallets.length).toBe(2);

  await sso.removeWallet(kp1.view_key.mainnet_primary);
  expect(sso.wallets.length).toBe(1);
  expect(sso.walletExists(kp1.view_key.mainnet_primary)).toBe(false);
  expect(sso.walletExists(kp2.view_key.mainnet_primary)).toBe(true);
  raw = await readFile(path);
  expect(raw.wallets.length).toBe(1);
  expect(raw.wallets[0].primary_address).toBe(kp2.view_key.mainnet_primary);
});

test("i: reload picks up external changes", async () => {
  const dir = `${OUT}/i`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  // add a wallet directly to the file, bypassing the instance
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp.view_key.mainnet_primary }],
      node_url: "http://external:18081",
      start_height: 999,
    },
    path,
  );

  // instance is stale
  expect(sso.wallets.length).toBe(0);
  expect(sso.node_url).toBe("http://127.0.0.1:18081");

  // reload
  await sso.reload();
  expect(sso.wallets.length).toBe(1);
  expect(sso.node_url).toBe("http://external:18081");
  expect(sso.start_height).toBe(999);
  expect(sso.getWallet(kp.view_key.mainnet_primary)).toBeDefined();

  // verify file matches
  const raw = await readFile(path);
  expect(raw.node_url).toBe("http://external:18081");
  expect(raw.start_height).toBe(999);
  expect(raw.wallets.length).toBe(1);
});

test("j: getWalletsOpened returns all wallets with keys", async () => {
  const dir = `${OUT}/j`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const kp1 = await makeTestKeyPair();
  const kp2 = await makeTestKeyPair();
  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);

  await sso.addViewWallet(kp1.view_key.mainnet_primary, kp1.view_key.view_key, {
    wallet_name: "wallet a",
  });
  await sso.addViewWallet(kp2.view_key.mainnet_primary, kp2.view_key.view_key, {
    wallet_name: "wallet b",
  });

  const opened = await sso.getWalletsOpened();
  expect(opened.length).toBe(2);
  expect(opened[0].secret_view_key).toBeDefined();
  expect(opened[1].secret_view_key).toBeDefined();

  const names = opened.map((w) => w.wallet_name).sort();
  expect(names).toEqual(["wallet a", "wallet b"]);

  // verify both wallets on disk
  const raw = await readFile(path);
  expect(raw.wallets.length).toBe(2);
  expect(raw.wallets.map((w: any) => w.wallet_name).sort()).toEqual([
    "wallet a",
    "wallet b",
  ]);
});
