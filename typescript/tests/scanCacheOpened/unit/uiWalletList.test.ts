import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  openWallets,
  ScanCacheOpened,
  type ManyScanCachesOpened,
  ScanSettingsOpened,
  type ScanCache,
  ViewPair,
} from "../../../dist/xmr3";

type Message = { kind: string; payload: unknown };
type Listener = (message: Message, sender: unknown, reply: (value: unknown) => void) => unknown;
const ROOT = resolve("test-data/ui-wallet-list");
const addresses = ["list-a", "list-b", "list-c"];
const context = new AsyncLocalStorage<string>();
let listeners: Map<string, Listener[]>;
let pending: Set<Promise<unknown>>;
let messages: { from: string; kind: string }[];
let models: { role: string; mco: ManyScanCachesOpened }[];
let opens: Promise<ManyScanCachesOpened>[];
let gates: (() => void)[];
let block: ((role: string, address: string) => Promise<void>) | undefined;
let directory: string;
let path: string;
let reloads: string[];
let unpauses: string[];
let keys: (string | undefined)[];
let originalBrowser: PropertyDescriptor | undefined;
let restore: (() => void)[];

function runtime(role: string) {
  if (!listeners.has(role)) listeners.set(role, []);
  return {
    onMessage: { addListener: (listener: Listener) => listeners.get(role)!.push(listener) },
    onConnect: { addListener: () => {} },
    getURL: (value: string) => value,
    sendMessage(message: Message) {
      messages.push({ from: role, kind: message.kind });
      const responses = [...listeners.keys()].filter((target) => target !== role)
        .map((target) => deliver(target, message));
      return responses.length ? Promise.race(responses) : Promise.resolve(undefined);
    },
  };
}

function deliver(role: string, message: Message): Promise<unknown> {
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ unhandled: message.kind }), 400);
    for (const listener of listeners.get(role) ?? []) {
      context.run(role, () => listener(message, {}, (value) => {
        clearTimeout(timer);
        resolve(value);
      }));
    }
  });
  pending.add(result);
  void result.finally(() => pending.delete(result));
  return result;
}
async function flush() {
  while (pending.size) await Promise.all([...pending]);
}
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  gates.push(release);
  return { promise, release };
}
async function until(read: () => boolean) {
  const start = Date.now();
  while (!read() && Date.now() - start < 400) await Bun.sleep(1);
  expect(read()).toBe(true);
}
async function settings(wallets: string[]) {
  await Bun.write(path, JSON.stringify({
    wallets: wallets.map((primary_address) => ({ primary_address, wallet_route: `main/no_domain/single/${addresses.indexOf(primary_address)}` })),
    node_url: "http://127.0.0.1:1", start_height: 0,
  }));
}
async function prepare(name: string, initial = addresses.slice(0, 1)) {
  directory = `${ROOT}/${name}`;
  path = `${directory}/ScanSettings.json`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await settings(initial);
}
function open(role: string, settingsPath = path, noWorker = true): Promise<ManyScanCachesOpened> {
  const rt = runtime(role);
  const operation = context.run(role, () => openWallets({
    scan_settings_path: settingsPath, no_worker: noWorker, no_stats: true,
    extensionMessageBus: role === "worker" ? "worker" : "ui",
    notifyMasterChanged: role === "worker" ? (params) => {
      void rt.sendMessage({ kind: "walletCacheChanged", payload: JSON.stringify(params) });
    } : undefined,
  })).then((mco) => {
    models.push({ role, mco });
    return mco;
  });
  opens.push(operation);
  return operation;
}
function names(mco: ManyScanCachesOpened) {
  return mco.wallets.map((wallet) => wallet.primary_address);
}
async function cache(worker: ManyScanCachesOpened, address: string, timestamp: number) {
  const value: ScanCache = {
    primary_address: address, daemon_height: 10, outputs: {}, own_key_images: {}, scanned_ranges: [],
    tx_logs: [{ timestamp, height: 9, inputs_index: [], payments: [], node_url: "http://127.0.0.1:1" }],
  };
  await Bun.write(`${directory}/${address}_cache.json`, JSON.stringify(value));
  await context.run("worker", () => worker.wallets.find((wallet) => wallet.primary_address === address)!.feed({ newCache: value, changed_outputs: [] }));
}

beforeEach(() => {
  listeners = new Map(); pending = new Set(); messages = []; models = []; opens = []; gates = []; reloads = []; unpauses = []; block = undefined;
  keys = addresses.map((address) => Bun.env["vk" + address]);
  for (const address of addresses) Bun.env["vk" + address] = "01".repeat(32);
  originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
  Object.defineProperty(globalThis, "browser", {
    configurable: true, get: () => ({ runtime: runtime(context.getStore() ?? "worker") }),
  });
  const viewPair = spyOn(ViewPair, "create").mockImplementation(async (primary_address) => {
    await block?.(context.getStore() ?? "", primary_address);
    return { primary_address, node_url: "http://127.0.0.1:1" } as ViewPair;
  });
  const unpause = spyOn(ScanCacheOpened.prototype, "unpause").mockImplementation(async () => {
    unpauses.push(context.getStore() ?? "");
  });
  const originalReload = ScanSettingsOpened.prototype.reload;
  const reload = spyOn(ScanSettingsOpened.prototype, "reload").mockImplementation(async function (this: ScanSettingsOpened) {
    reloads.push(context.getStore() ?? "");
    return originalReload.call(this);
  });
  restore = [() => reload.mockRestore(), () => unpause.mockRestore(), () => viewPair.mockRestore()];
});

afterEach(async () => {
  for (const release of gates) release();
  await Promise.allSettled(opens);
  await flush();
  for (const { mco } of models) mco.unwatchConnectionStatus();
  if (directory) await Bun.write(`${directory}/result.json`, JSON.stringify({
    messages, reloads, unpauses, models: models.map(({ role, mco }) => ({ role, wallets: names(mco) })),
  }, null, 2));
  for (const reset of restore) reset();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
  for (let index = 0; index < addresses.length; index++) {
    const key = "vk" + addresses[index];
    if (keys[index] === undefined) delete Bun.env[key]; else Bun.env[key] = keys[index];
  }
});

test("worker rebuild updates every open UI mco without a consumer reload", async () => {
  await prepare("add");
  const worker = await open("worker");
  const ui = await open("ui");
  const other = await open("other");
  await settings(addresses.slice(0, 2));
  await context.run("worker", () => worker.buildWallets());
  await flush();
  expect(names(ui)).toEqual(addresses.slice(0, 2));
  expect(names(other)).toEqual(addresses.slice(0, 2));
  expect(messages.filter((message) => message.kind === "worker.buildWallets")).toEqual([]);
  expect(messages.filter((message) => message.kind === "walletsChanged")).toEqual([{ from: "worker", kind: "walletsChanged" }]);
});

test("a UI open does not unpause or rewrite wallet settings", async () => {
  await prepare("read-only-ui");
  const before = await Bun.file(path).text();
  await open("ui");
  expect(unpauses).toEqual([]);
  expect(await Bun.file(path).text()).toBe(before);
});

test("a UI role cannot start a scan worker", async () => {
  await prepare("ui-role");
  await open("ui", path, false);
  expect(unpauses).toEqual([]);
});

test("a change to another settings file does not reload this UI", async () => {
  await prepare("settings-scope");
  const worker = await open("worker");
  const otherPath = `${directory}/OtherSettings.json`;
  await Bun.write(otherPath, JSON.stringify({ wallets: [{ primary_address: addresses[2] }], node_url: "http://127.0.0.1:1", start_height: 0 }));
  const other = await open("other", otherPath);
  reloads.length = 0;
  await settings(addresses.slice(0, 2));
  await context.run("worker", () => worker.buildWallets());
  await flush();
  expect(names(other)).toEqual([addresses[2]!]);
  expect(reloads.filter((role) => role === "other")).toEqual([]);
});

test("remove and an empty list reach open UI mcos", async () => {
  await prepare("remove", addresses.slice(0, 2));
  const worker = await open("worker");
  const ui = await open("ui");
  await context.run("worker", () => worker.removeWallet(addresses[1]!));
  await flush();
  expect(names(ui)).toEqual([addresses[0]!]);
  await context.run("worker", () => worker.removeWallet(addresses[0]!));
  await flush();
  expect(names(ui)).toEqual([]);
});

test("a cache update during wallet reload reaches the new instance", async () => {
  await prepare("cache-during-reload");
  const worker = await open("worker");
  const ui = await open("ui");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[1]) { entered = true; await gate.promise; }
  };
  await settings(addresses.slice(0, 2));
  await context.run("worker", () => worker.buildWallets());
  await until(() => entered);
  await cache(worker, addresses[1]!, 123);
  gate.release();
  await flush();
  expect(ui.wallets[1]?.tx_logs[0]?.timestamp).toBe(123);
});

test("rapid wallet changes are not lost while a reload waits", async () => {
  await prepare("rapid-changes");
  const worker = await open("worker");
  const ui = await open("ui");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[1]) { entered = true; await gate.promise; }
  };
  await settings(addresses.slice(0, 2));
  await context.run("worker", () => worker.buildWallets());
  await until(() => entered);
  await settings(addresses);
  await context.run("worker", () => worker.buildWallets());
  await context.run("worker", () => worker.removeWallet(addresses[0]!));
  gate.release();
  await flush();
  expect(names(ui)).toEqual(addresses.slice(1));
});

for (const failure of ["missing", "invalid"]) {
  test(`${failure} settings clear the UI list and recovery restores it`, async () => {
    await prepare(failure, addresses.slice(0, 2));
    const worker = await open("worker");
    const ui = await open("ui");
    if (failure === "missing") await rm(path); else await Bun.write(path, "{");
    await context.run("worker", () => runtime("worker").sendMessage({ kind: "walletsChanged", payload: { scan_settings_path: path } }));
    await flush();
    expect(names(ui)).toEqual([]);
    expect(await Bun.file(path).text().catch(() => "missing")).toBe(failure === "missing" ? "missing" : "{");
    await settings([addresses[1]!]);
    await context.run("worker", () => worker.buildWallets());
    await flush();
    expect(names(ui)).toEqual([addresses[1]!]);
  });
}

test("startup listeners receive changes while the UI opens", async () => {
  await prepare("startup");
  const worker = await open("worker");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[0]) { entered = true; await gate.promise; }
  };
  const opening = open("ui");
  await until(() => entered && !!listeners.get("ui")?.length);
  await settings(addresses.slice(0, 2));
  await context.run("worker", () => worker.buildWallets());
  await cache(worker, addresses[1]!, 234);
  gate.release();
  const ui = await opening;
  await flush();
  expect(names(ui)).toEqual(addresses.slice(0, 2));
  expect(ui.wallets[1]?.tx_logs[0]?.timestamp).toBe(234);
});

test("cache updates do not reload the wallet list", async () => {
  await prepare("cache-only");
  const worker = await open("worker");
  const ui = await open("ui");
  reloads.length = 0;
  for (let index = 1; index <= 3; index++) await cache(worker, addresses[0]!, index);
  await flush();
  expect(ui.wallets[0]?.tx_logs[0]?.timestamp).toBe(3);
  expect(reloads.filter((role) => role === "ui")).toEqual([]);
});
