import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  writeScanSettings,
  openWallets,
  makeTestKeyPair,
  type ManyScanCachesOpened,
} from "../../dist/xmr3";

const OUT = "test-data/small_scan_packed";
const SCAN_SETTINGS_PATH = `${OUT}/ScanSettings.json`;
const NODE_URL = "https://node.monero.fail";
const START_HEIGHT = 3160222;
const TARGET = START_HEIGHT + 10;

async function clean() {
  await rm(OUT, { force: true, recursive: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
}

test("packed small: one wallet scans 10 blocks via inline worker", async () => {
  await clean();

  const k = await makeTestKeyPair();
  Bun.env[`sk${k.view_key.mainnet_primary}`] = k.spend_key;
  Bun.env[`vk${k.view_key.mainnet_primary}`] = k.view_key.view_key;

  await writeScanSettings(
    {
      wallets: [{ primary_address: k.view_key.mainnet_primary }],
      node_url: NODE_URL,
      start_height: START_HEIGHT,
      cpu_worker_count: 1,
    },
    SCAN_SETTINGS_PATH,
  );

  let doneResolve: () => void;
  const done = new Promise<void>((r) => {
    doneResolve = r;
  });

  const wallets: ManyScanCachesOpened = await openWallets({
    scan_settings_path: SCAN_SETTINGS_PATH,
    pathPrefix: `${OUT}/`,
    no_stats: true,
    notifyMasterChanged: async (params) => {
      const last = params.newCache.scanned_ranges?.at(-1);
      if (last && last.end >= TARGET) doneResolve();
    },
  });

  await done;
  const height = wallets.wallets[0].current_height;
  expect(height).toBeGreaterThanOrEqual(TARGET);
  await wallets.stopWorker();

  // check test data dir for leaks
  const cacheFile = Bun.file(
    `${OUT}/${k.view_key.mainnet_primary}_cache.json`,
  );
  expect(await cacheFile.exists()).toBe(true);
}, 120000);
