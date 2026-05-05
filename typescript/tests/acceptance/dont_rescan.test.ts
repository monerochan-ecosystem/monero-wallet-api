import { test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  writeScanSettings,
  openWallets,
  makeTestKeyPair,
  type ManyScanCachesOpened,
} from "../../dist/api";

const OUT = "test-data/dont_rescan";
const SCAN_SETTINGS_PATH = `${OUT}/ScanSettings.json`;
const NODE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;
const TARGET = START_HEIGHT + 1000;

async function clean() {
  await rm(OUT, { force: true, recursive: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
}

// acceptance test to measure the cost of re-scanning wallets that already
// have the required cache range. currently the coordinator creates work
// items for every wallet regardless of cached state, so both passes take
// similar time. after the "skip scanned wallets" optimization the second
// pass (one new wallet, ten already synced) should be ~10x faster.
test("a: 10 wallets first pass vs one new wallet second pass", async () => {
  await clean();

  // -- setup: ten keypairs ------------------------------------------------
  const kp: {
    spend_key: string;
    view_key: { view_key: string; mainnet_primary: string };
  }[] = [];
  for (let i = 0; i < 10; i++) {
    const k = await makeTestKeyPair();
    kp.push(k);
    Bun.env[`sk${k.view_key.mainnet_primary}`] = k.spend_key;
    Bun.env[`vk${k.view_key.mainnet_primary}`] = k.view_key.view_key;
  }

  // -- first pass: scan 1000 blocks with 10 wallets -----------------------
  await writeScanSettings(
    {
      wallets: kp.map((k) => ({
        primary_address: k.view_key.mainnet_primary,
      })),
      node_url: NODE_URL,
      start_height: START_HEIGHT,
    },
    SCAN_SETTINGS_PATH,
  );

  let t1 = 0;
  let t2 = 0;
  let resolveFirst: () => void;
  const firstDone = new Promise<void>((r) => {
    resolveFirst = r;
  });
  const progressFirst: Record<string, number> = {};

  let wallets: ManyScanCachesOpened | undefined;

  wallets = await openWallets({
    scan_settings_path: SCAN_SETTINGS_PATH,
    pathPrefix: `${OUT}/`,
    no_stats: true,
    notifyMasterChanged: async (params) => {
      if (!t1) {
        t1 = Date.now();
        console.log(
          "  [first pass] first result at",
          new Date(t1).toISOString(),
        );
      }
      const addr = params.newCache.primary_address;
      const last = params.newCache.scanned_ranges?.at(-1);
      if (last) progressFirst[addr] = last.end;
      // wait until all 10 wallets have reached target
      const doneCount = Object.values(progressFirst).filter(
        (v) => v >= TARGET,
      ).length;
      if (doneCount === 10 && !t2) {
        t2 = Date.now();
        console.log(
          "  [first pass] all wallets reached target at",
          new Date(t2).toISOString(),
        );
        resolveFirst();
      }
    },
  });

  await firstDone;
  wallets!.stopWorker();

  const diff1 = (t2 - t1) / 1000;
  console.log(`  [first pass] 10 wallets, 1000 blocks: ${diff1.toFixed(1)}s`);

  // -- second pass: add 11th wallet, scan again ---------------------------
  const k11 = await makeTestKeyPair();
  Bun.env[`sk${k11.view_key.mainnet_primary}`] = k11.spend_key;
  Bun.env[`vk${k11.view_key.mainnet_primary}`] = k11.view_key.view_key;
  const allKp = [...kp, k11];

  await writeScanSettings(
    {
      wallets: allKp.map((k) => ({
        primary_address: k.view_key.mainnet_primary,
      })),
      node_url: NODE_URL,
      start_height: START_HEIGHT,
    },
    SCAN_SETTINGS_PATH,
  );

  let t3 = 0;
  let t4 = 0;
  let resolveSecond: () => void;
  const secondDone = new Promise<void>((r) => {
    resolveSecond = r;
  });
  const progressSecond: Record<string, number> = {};
  const expectedWallets2 = 11;

  wallets = await openWallets({
    scan_settings_path: SCAN_SETTINGS_PATH,
    pathPrefix: `${OUT}/`,
    no_stats: true,
    notifyMasterChanged: async (params) => {
      if (!t3) {
        t3 = Date.now();
        console.log(
          "  [second pass] first result at",
          new Date(t3).toISOString(),
        );
      }
      const addr = params.newCache.primary_address;
      const last = params.newCache.scanned_ranges?.at(-1);
      if (last) progressSecond[addr] = last.end;
      // wait until all 11 wallets have reached target
      const doneCount = Object.values(progressSecond).filter(
        (v) => v >= TARGET,
      ).length;
      if (doneCount === expectedWallets2 && !t4) {
        t4 = Date.now();
        console.log(
          "  [second pass] all wallets reached target at",
          new Date(t4).toISOString(),
        );
        resolveSecond();
      }
    },
  });

  await secondDone;
  wallets!.stopWorker();

  const diff2 = (t4 - t3) / 1000;
  console.log(`  [second pass] 11 wallets (10 synced): ${diff2.toFixed(1)}s`);
  console.log(`  ratio: ${(diff2 / diff1).toFixed(2)}x`);
  // currently both passes do the same amount of work so ratio should be ~1x
  // after the skip-scanned-wallets optimization ratio should be ~0.1x
}, 2040000);
