import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ActionLogOpened,
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
// the background page gets no_worker false, so the library installs its own cache push.
// unpause is mocked, so no worker starts.
function open(role: string, settingsPath = path, noWorker = role !== "background"): Promise<ManyScanCachesOpened> {
  const operation = context.run(role, () => openWallets({
    scan_settings_path: settingsPath, no_worker: noWorker, no_stats: true,
    extensionMessageBus: role === "background" ? "background" : "ui",
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
async function cache(background: ManyScanCachesOpened, address: string, timestamp: number) {
  const value: ScanCache = {
    primary_address: address, daemon_height: 10, outputs: {}, own_key_images: {}, scanned_ranges: [],
    tx_logs: [{ timestamp, height: 9, inputs_index: [], payments: [], node_url: "http://127.0.0.1:1" }],
  };
  await Bun.write(`${directory}/${address}_cache.json`, JSON.stringify(value));
  await context.run("background", () => background.wallets.find((wallet) => wallet.primary_address === address)!.feed({ newCache: value, changed_outputs: [] }));
}

beforeEach(() => {
  listeners = new Map(); pending = new Set(); messages = []; models = []; opens = []; gates = []; reloads = []; unpauses = []; block = undefined;
  keys = addresses.map((address) => Bun.env["vk" + address]);
  for (const address of addresses) Bun.env["vk" + address] = "01".repeat(32);
  originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
  Object.defineProperty(globalThis, "browser", {
    configurable: true, get: () => ({ runtime: runtime(context.getStore() ?? "background") }),
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

test("a UI send requires a reply from the background wallet", async () => {
  await prepare("send-without-background");
  const ui = await open("ui");
  const send = () => context.run("ui", () => ui.makeSignSend({
    primary_address: "missing-wallet", payments: [], input_indexes: [],
  }));
  await expect(send()).rejects.toThrow("no reply from the extension bus");
  const background = await open("background");
  await expect(send()).rejects.toThrow("wallet not found");
  const result = {
    status: "OK", cache_error: "disk full", reason: "", double_spend: false,
    fee_too_low: false, invalid_input: false, invalid_output: false, low_mixin: false,
    not_relayed: false, overspend: false, too_big: false, untrusted: false,
  };
  const reply = spyOn(background.wallets[0]!, "makeSignSend").mockResolvedValue(result);
  restore.push(() => reply.mockRestore());
  expect(await context.run("ui", () => ui.makeSignSend({
    primary_address: addresses[0]!, payments: [], input_indexes: [],
  }))).toEqual(result);
});

test("every background command from the UI goes through callExtensionBackground", async () => {
  await prepare("one-bus-method");
  const ui = await open("ui");
  const sent: string[] = [];
  const send = spyOn(ui.actionLogOpened, "callExtensionBackground").mockImplementation(async (kind: string) => {
    sent.push(kind);
    return {};
  });
  restore.push(() => send.mockRestore());
  const address = addresses[0]!;
  await context.run("ui", async () => {
    await ui.stopWorker();
    await ui.changeNodeUrl("http://127.0.0.1:2");
    await ui.changeStartHeight(3);
    await ui.changeNodeUrlAndStartHeight("http://127.0.0.1:3", 4);
    await ui.setLogSettings("off");
    await ui.buildWallets();
    await ui.makeSignSend({ primary_address: address, payments: [], input_indexes: [] });
    await ui.sweepSignSend({ primary_address: address, address: "dest", input_indexes: [] });
    await ui.rebroadcastTx({ primary_address: address, tx_log_index: 0 });
    await ui.releaseInputs({ primary_address: address, tx_log_index: 0 });
    await ui.dismissSendPlate({ primary_address: address, tx_log_index: 0 });
  });
  // each background command has one kind. the bus method is the only way to the runtime.
  expect(sent).toEqual([
    "worker.stopWorker", "worker.setNodeUrl", "worker.setStartHeight", "worker.changeNodeUrlAndStartHeight",
    "worker.setLogSettings", "worker.buildWallets", "worker.makeSignSend", "worker.sweepSignSend",
    "worker.rebroadcastTx", "worker.releaseInputs", "worker.dismissSendPlate",
  ]);
  expect(messages.filter((message) => message.kind.startsWith("worker."))).toEqual([]);
});

test("a background error reaches the UI for a command that used to ignore the reply", async () => {
  await prepare("background-error");
  const background = await open("background");
  const ui = await open("ui");
  const stop = spyOn(background, "stopWorker").mockRejectedValue(new Error("scanner refuses to stop"));
  restore.push(() => stop.mockRestore());
  await expect(context.run("ui", () => ui.stopWorker())).rejects.toThrow("scanner refuses to stop");
});

test("a background page without a wallet answers an error for every command", async () => {
  await prepare("background-not-ready");
  // a listener but no bound wallet: the time before openWallets binds it, or an open that failed after create
  await context.run("background", () => ActionLogOpened.create({ extensionMessageBus: "background", path: `${directory}/not-ready-actionlog.sqlite` }));
  const ui = await open("ui");
  const calls = [
    () => ui.stopWorker(), () => ui.buildWallets(), () => ui.changeNodeUrl("http://127.0.0.1:2"),
    () => ui.changeStartHeight(3), () => ui.changeNodeUrlAndStartHeight("http://127.0.0.1:3", 4), () => ui.setLogSettings("off"),
  ];
  for (const call of calls) await expect(context.run("ui", call)).rejects.toThrow("background wallet is not ready");
});

test("a background error of changeNodeUrlAndStartHeight reaches the UI", async () => {
  await prepare("node-url-error");
  const background = await open("background");
  const ui = await open("ui");
  const change = spyOn(background, "changeNodeUrlAndStartHeight").mockRejectedValue(new Error("node url refused"));
  restore.push(() => change.mockRestore());
  await expect(context.run("ui", () => ui.changeNodeUrlAndStartHeight("http://127.0.0.1:2", 1))).rejects.toThrow("node url refused");
});

test("background rebuild updates every open UI mco without a consumer reload", async () => {
  await prepare("add");
  const background = await open("background");
  const ui = await open("ui");
  const other = await open("other");
  await settings(addresses.slice(0, 2));
  await context.run("background", () => background.buildWallets());
  await flush();
  expect(names(ui)).toEqual(addresses.slice(0, 2));
  expect(names(other)).toEqual(addresses.slice(0, 2));
  expect(messages.filter((message) => message.kind === "worker.buildWallets")).toEqual([]);
  expect(messages.filter((message) => message.kind === "walletsChanged")).toEqual([{ from: "background", kind: "walletsChanged" }]);
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
  const background = await open("background");
  const otherPath = `${directory}/OtherSettings.json`;
  await Bun.write(otherPath, JSON.stringify({ wallets: [{ primary_address: addresses[2] }], node_url: "http://127.0.0.1:1", start_height: 0 }));
  const other = await open("other", otherPath);
  reloads.length = 0;
  await settings(addresses.slice(0, 2));
  await context.run("background", () => background.buildWallets());
  await flush();
  expect(names(other)).toEqual([addresses[2]!]);
  expect(reloads.filter((role) => role === "other")).toEqual([]);
});

test("remove and an empty list reach open UI mcos", async () => {
  await prepare("remove", addresses.slice(0, 2));
  const background = await open("background");
  const ui = await open("ui");
  await context.run("background", () => background.removeWallet(addresses[1]!));
  await flush();
  expect(names(ui)).toEqual([addresses[0]!]);
  await context.run("background", () => background.removeWallet(addresses[0]!));
  await flush();
  expect(names(ui)).toEqual([]);
});

test("a cache update during wallet reload reaches the new instance", async () => {
  await prepare("cache-during-reload");
  const background = await open("background");
  const ui = await open("ui");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[1]) { entered = true; await gate.promise; }
  };
  await settings(addresses.slice(0, 2));
  await context.run("background", () => background.buildWallets());
  await until(() => entered);
  await cache(background, addresses[1]!, 123);
  gate.release();
  await flush();
  expect(ui.wallets[1]?.tx_logs[0]?.timestamp).toBe(123);
});

test("rapid wallet changes are not lost while a reload waits", async () => {
  await prepare("rapid-changes");
  const background = await open("background");
  const ui = await open("ui");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[1]) { entered = true; await gate.promise; }
  };
  await settings(addresses.slice(0, 2));
  await context.run("background", () => background.buildWallets());
  await until(() => entered);
  await settings(addresses);
  await context.run("background", () => background.buildWallets());
  await context.run("background", () => background.removeWallet(addresses[0]!));
  gate.release();
  await flush();
  expect(names(ui)).toEqual(addresses.slice(1));
});

for (const failure of ["missing", "invalid"]) {
  test(`${failure} settings clear the UI list and recovery restores it`, async () => {
    await prepare(failure, addresses.slice(0, 2));
    const background = await open("background");
    const ui = await open("ui");
    if (failure === "missing") await rm(path); else await Bun.write(path, "{");
    await context.run("background", () => runtime("background").sendMessage({ kind: "walletsChanged", payload: { scan_settings_path: path } }));
    await flush();
    expect(names(ui)).toEqual([]);
    expect(await Bun.file(path).text().catch(() => "missing")).toBe(failure === "missing" ? "missing" : "{");
    await settings([addresses[1]!]);
    await context.run("background", () => background.buildWallets());
    await flush();
    expect(names(ui)).toEqual([addresses[1]!]);
  });
}

test("startup listeners receive changes while the UI opens", async () => {
  await prepare("startup");
  const background = await open("background");
  const gate = held(); let entered = false;
  block = async (role, address) => {
    if (role === "ui" && address === addresses[0]) { entered = true; await gate.promise; }
  };
  const opening = open("ui");
  await until(() => entered && !!listeners.get("ui")?.length);
  await settings(addresses.slice(0, 2));
  await context.run("background", () => background.buildWallets());
  await cache(background, addresses[1]!, 234);
  gate.release();
  const ui = await opening;
  await flush();
  expect(names(ui)).toEqual(addresses.slice(0, 2));
  expect(ui.wallets[1]?.tx_logs[0]?.timestamp).toBe(234);
});

test("cache updates do not reload the wallet list", async () => {
  await prepare("cache-only");
  const background = await open("background");
  const ui = await open("ui");
  reloads.length = 0;
  for (let index = 1; index <= 3; index++) await cache(background, addresses[0]!, index);
  await flush();
  expect(ui.wallets[0]?.tx_logs[0]?.timestamp).toBe(3);
  expect(reloads.filter((role) => role === "ui")).toEqual([]);
});
