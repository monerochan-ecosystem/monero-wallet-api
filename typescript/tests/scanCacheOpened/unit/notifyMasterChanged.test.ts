import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openWallets } from "../../../wallet-api/scanning-syncing/openWallet";
import { ScanCacheOpened, type ManyScanCachesOpened } from "../../../wallet-api/scanning-syncing/scanresult/scanCacheOpened";
import type { CacheChangedCallbackParameters, ScanCache } from "../../../wallet-api/scanning-syncing/scanresult/scanCache";
import { ViewPair } from "../../../wallet-api/viewpair/ViewPair";

const ROOT = resolve("test-data/cache-notify");
const addresses = ["notify-a", "notify-b", "notify-c"];
let startup: string[] = [];
let runs: { dir: string; calls: string[]; mco: ManyScanCachesOpened }[] = [];
let keys: (string | undefined)[] = [];
let restoreViewPair: () => void;
let restoreUnpause: () => void;

function change(address: string): CacheChangedCallbackParameters {
  const cache: ScanCache = {
    primary_address: address,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    daemon_height: 1,
    tx_logs: [{ timestamp: 1, height: 0, node_url: "http://127.0.0.1:1", inputs_index: [], payments: [] }],
  };
  return { newCache: cache, changed_outputs: [] };
}

beforeEach(() => {
  runs = [];
  startup = [];
  keys = addresses.map((address) => Bun.env["vk" + address]);
  for (const address of addresses) Bun.env["vk" + address] = "01".repeat(32);
  const viewPair = spyOn(ViewPair, "create").mockImplementation(async (primary_address) =>
    ({ primary_address, node_url: "http://127.0.0.1:1" }) as ViewPair,
  );
  const unpause = spyOn(ScanCacheOpened.prototype, "unpause").mockImplementation(async function (this: ScanCacheOpened) {
    if (this.no_worker) return;
    // simulate the first worker update before create returns, without starting a worker
    Reflect.set(this, "_no_stats", true);
    for (const address of startup) await this.feed(change(address));
  });
  restoreViewPair = () => viewPair.mockRestore();
  restoreUnpause = () => unpause.mockRestore();
});

afterEach(async () => {
  for (const run of runs) {
    run.mco.unwatchConnectionStatus();
    await run.mco.stopWorker();
    await Bun.write(`${run.dir}/calls.json`, JSON.stringify(run.calls, null, 2));
  }
  restoreUnpause();
  restoreViewPair();
  for (let index = 0; index < addresses.length; index++) {
    const key = "vk" + addresses[index];
    if (keys[index] === undefined) delete Bun.env[key];
    else Bun.env[key] = keys[index];
  }
});

async function open(name: string, count = 3, noWorker = true) {
  const dir = `${ROOT}/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const path = `${dir}/ScanSettings.json`;
  await Bun.write(path, JSON.stringify({
    wallets: addresses.slice(0, count).map((primary_address) => ({ primary_address })),
    node_url: "http://127.0.0.1:1", start_height: 0,
  }));
  const calls: string[] = [];
  const mco = await openWallets({
    scan_settings_path: path,
    no_worker: noWorker,
    no_stats: true,
    notifyMasterChanged: (params) => { calls.push(params.newCache.primary_address); },
  });
  runs.push({ dir, calls, mco });
  return { mco, calls };
}

test("a master scan update notifies once", async () => {
  const { mco, calls } = await open("master-scan");
  await mco.feed(change(addresses[0]!));
  expect(calls).toEqual([addresses[0]!]);
});

test("a slave scan update notifies once and updates the matching wallet", async () => {
  const { mco, calls } = await open("slave-scan");
  const update = change(addresses[1]!);
  await mco.feed(update);
  expect(mco.wallets[1]!.cache).toBe(update.newCache);
  expect(calls).toEqual([addresses[1]!]);
});

test("a slave local write notifies once", async () => {
  const { mco, calls } = await open("slave-local-write");
  await mco.wallets[1]!.feed(change(addresses[1]!));
  expect(calls).toEqual([addresses[1]!]);
});

test("an update for an unknown address does not notify", async () => {
  const { mco, calls } = await open("unknown-address");
  await mco.feed(change("not-opened"));
  expect(calls).toEqual([]);
});

test("one wallet notifies once per update", async () => {
  const { mco, calls } = await open("single-wallet", 1);
  await mco.feed(change(addresses[0]!));
  await mco.wallets[0]!.feed(change(addresses[0]!));
  expect(calls).toEqual([addresses[0]!, addresses[0]!]);
});

test("new wallet instances notify once after rebuild", async () => {
  const { mco, calls } = await open("rebuild");
  const before = mco.wallets[1];
  await mco.buildWallets();
  expect(mco.wallets[1]).not.toBe(before);
  await mco.feed(change(addresses[1]!));
  await mco.wallets[1]!.feed(change(addresses[1]!));
  expect(calls).toEqual([addresses[1]!, addresses[1]!]);
});

test("startup updates are heard before create returns", async () => {
  startup = [addresses[0]!, addresses[1]!];
  const { calls } = await open("startup", 3, false);
  expect(calls).toEqual(startup);
});

test("no wallets means no notification", async () => {
  const { mco, calls } = await open("no-wallets", 0);
  await mco.feed(change(addresses[0]!));
  expect(calls).toEqual([]);
});
