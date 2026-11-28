import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ActionLogOpened } from "../../../wallet-api/actionlog/actionLogOpened";

const browserGlobals = globalThis as { browser?: unknown; chrome?: unknown };
const originalBrowser = browserGlobals.browser;
const originalChrome = browserGlobals.chrome;
afterEach(() => {
  browserGlobals.browser = originalBrowser;
  browserGlobals.chrome = originalChrome;
});

type BusMessage = { kind: string; payload: unknown };
function extensionRuntime(sendMessage: (message: BusMessage) => Promise<unknown>, extensionUrl: string) {
  const listeners: ((message: BusMessage, sender: unknown, reply: (response: unknown) => void) => boolean)[] = [];
  return {
    sendMessage,
    getURL: (path: string) => `${extensionUrl}${path}`,
    onConnect: { addListener() {} },
    onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
    receive(kind: string, payload: unknown, sender: unknown = {}) {
      const reply = Promise.withResolvers<unknown>();
      const claimed = listeners.map((listener) => listener({ kind, payload }, sender, reply.resolve));
      return claimed.some(Boolean) ? reply.promise : undefined;
    },
  };
}

const memoryBackend = {
  append: async () => {},
  invocation: async () => null,
  invocations: async () => [],
};

async function setup(name: string) {
  const folder = resolve("test-data/actionlog-backends", name);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  return folder;
}

test("the action log factory saves and reopens a SQLite invocation", async () => {
  const folder = await setup("sqlite");
  const options = { backend: "sqlite" as const, path: `${folder}/actionlog.sqlite` };
  const log = await ActionLogOpened.create(options);
  const started = await log.append({ type: "session_start", invocationId: "payment", stage: "invoked", toolId: "001" });
  await log.append({ type: "dismiss", invocationId: "payment", stage: "invoked", toolId: "001" });
  const reopened = await ActionLogOpened.create(options);
  const invocation = await reopened.invocation("payment");
  await Bun.write(`${folder}/result.json`, JSON.stringify(invocation, null, 2));
  expect(invocation?.events[0]).toEqual(started);
  expect(invocation?.events.map(event => event.type)).toEqual(["session_start", "dismiss"]);
  expect(invocation?.status).toBe("dismissed");
  expect(reopened.invocations("active")).toEqual([]);
});

test("the action log factory loads in a classic browser script without native modules", async () => {
  const folder = await setup("browser");
  const entry = `${folder}/entry.ts`;
  const source = resolve("wallet-api/actionlog/actionLogOpened.ts");
  await Bun.write(entry, `import { ActionLogOpened } from ${JSON.stringify(source)};
globalThis.openActionLog = () => ActionLogOpened.create({ backend: "idb" });`);
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  await Bun.write(`${folder}/bundle.js`, code);
  const context = { openActionLog: undefined as undefined | (() => Promise<unknown>) };
  runInNewContext(code, context);
  let error = "";
  try { await context.openActionLog!(); } catch (caught) { error = String(caught); }
  await Bun.write(`${folder}/result.json`, JSON.stringify({ error, bytes: code.length }, null, 2));
  expect(error).toContain("IndexedDB not available");
});

test("a sidebar takes pending metadata on startup and takes new metadata only for its window", async () => {
  const pending = [{ route: "initial" }];
  const messages: BusMessage[] = [];
  const runtime = extensionRuntime(async (message) => {
    messages.push(message);
    return { ok: true, result: pending.shift() ?? null };
  }, "chrome-extension://wallet/");
  browserGlobals.chrome = { runtime, windows: { getCurrent: async () => ({ id: 18 }) } };
  const log = await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "ui" });
  const received: Record<string, unknown>[] = [];
  await log.watchSidebarMetadata((metadata) => { received.push(metadata); });
  expect(received).toEqual([{ route: "initial" }]);

  pending.push({ route: "next" });
  const sender = { url: "chrome-extension://wallet/background.html" };
  await runtime.receive("sidebarMetadataChanged", { windowId: 19 }, sender);
  expect(messages).toEqual([{ kind: "takeSidebarMetadata", payload: { windowId: 18 } }]);
  await runtime.receive("sidebarMetadataChanged", { windowId: 18 }, sender);
  await runtime.receive("sidebarMetadataChanged", { windowId: 18 }, sender);
  expect(received).toEqual([{ route: "initial" }, { route: "next" }]);
  expect(messages).toHaveLength(3);
});

test("Firefox opens the native sidebar in the click and delivers metadata through the background bus", async () => {
  const extensionUrl = "moz-extension://wallet/";
  const sender = { url: `${extensionUrl}actionlog.html`, tab: { windowId: 18 } };
  const queuedMessages: BusMessage[] = [];
  const background = extensionRuntime(async (message) => { queuedMessages.push(message); }, extensionUrl);
  let openCalls = 0;
  const nativeOpen = Promise.withResolvers<void>();
  const sidebarAction = { open: () => { openCalls++; return nativeOpen.promise; } };
  browserGlobals.browser = { runtime: background };
  await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "background" });

  const requests: BusMessage[] = [];
  const runtime = extensionRuntime(async ({ kind, payload }) => {
    requests.push({ kind, payload });
    const browser = browserGlobals.browser;
    browserGlobals.browser = { runtime: background };
    try { return background.receive(kind, payload, sender); }
    finally { browserGlobals.browser = browser; }
  }, extensionUrl);
  browserGlobals.browser = { runtime, sidebarAction };
  const log = await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "ui" });
  const metadata = { route: "form" };
  const opened = log.openSidebar({ metadata });
  expect(openCalls).toBe(1);
  expect(queuedMessages).toEqual([]);
  nativeOpen.resolve();
  await opened;
  expect(openCalls).toBe(1);
  expect(requests).toEqual([{ kind: "openSidebar", payload: { metadata, windowId: undefined } }]);
  expect(queuedMessages).toEqual([{ kind: "sidebarMetadataChanged", payload: { windowId: 18 } }]);
  expect(await background.receive("takeSidebarMetadata", { windowId: 18 }, { url: `${extensionUrl}sidebar.html` })).toEqual({ ok: true, result: metadata });
});

test("Chrome opens the global sidebar in the current window and the wallet background delivers metadata once", async () => {
  const extensionUrl = "chrome-extension://wallet/";
  const sent: BusMessage[] = [];
  const background = extensionRuntime(async (message) => { sent.push(message); }, extensionUrl);
  browserGlobals.chrome = { runtime: background };
  await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "background" });

  let windowId = 18;
  const runtime = extensionRuntime(async ({ kind, payload }) => {
    const chrome = browserGlobals.chrome;
    browserGlobals.chrome = { runtime: background };
    try { return background.receive(kind, payload, { url: `${extensionUrl}actionlog.html`, tab: { windowId } }); }
    finally { browserGlobals.chrome = chrome; }
  }, extensionUrl);
  const opens: unknown[] = [];
  let nativeOpen = Promise.withResolvers<void>();
  const sidePanel = { open: (options: unknown) => { opens.push(options); return nativeOpen.promise; } };
  browserGlobals.chrome = { runtime, sidePanel, windows: { getCurrent: async () => ({ id: windowId }) } };
  const log = await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "ui" });
  const sidebar = { url: `${extensionUrl}sidebar.html` };
  const take = (id: number) => background.receive("takeSidebarMetadata", { windowId: id }, sidebar);

  const first = log.openSidebar({ metadata: { route: "one" } });
  const firstOutcome = first.catch((error) => error);
  await Promise.resolve();
  expect(opens).toEqual([{ windowId: 18 }]);
  expect(await take(18)).toEqual({ ok: true, result: null });
  nativeOpen.resolve();
  expect(await firstOutcome).toBeUndefined();

  windowId = 19;
  await log.openSidebar({ metadata: { route: "two" } });
  expect(opens).toEqual([{ windowId: 18 }, { windowId: 19 }]);
  expect(await take(20)).toEqual({ ok: true, result: null });
  expect(await take(18)).toEqual({ ok: true, result: { route: "one" } });
  expect(await take(19)).toEqual({ ok: true, result: { route: "two" } });
  expect(await take(19)).toEqual({ ok: true, result: null });

  const delayedOpen = Promise.withResolvers<void>();
  nativeOpen = delayedOpen;
  const older = log.openSidebar({ metadata: { route: "older" } });
  await Promise.resolve();
  nativeOpen = Promise.withResolvers<void>();
  nativeOpen.resolve();
  await log.openSidebar({ metadata: { route: "latest" } });
  delayedOpen.resolve();
  await older;
  expect(await take(19)).toEqual({ ok: true, result: { route: "latest" } });

  nativeOpen = Promise.withResolvers<void>();
  const failed = log.openSidebar({ metadata: { route: "failed" } });
  await Promise.resolve();
  nativeOpen.reject(new Error("native panel failed"));
  await expect(failed).rejects.toThrow("native panel failed");
  expect(await take(19)).toEqual({ ok: true, result: null });
  expect(sent).toEqual([
    { kind: "sidebarMetadataChanged", payload: { windowId: 18 } },
    { kind: "sidebarMetadataChanged", payload: { windowId: 19 } },
    { kind: "sidebarMetadataChanged", payload: { windowId: 19 } },
  ]);
});

test("the wallet background refuses sidebar metadata from web pages and other windows", async () => {
  const extensionUrl = "chrome-extension://wallet/";
  const background = extensionRuntime(async () => {}, extensionUrl);
  browserGlobals.chrome = { runtime: background };
  await ActionLogOpened.create({ backendInstance: memoryBackend, extensionMessageBus: "background" });
  const webPage = { url: "https://merchant.example/checkout", tab: { windowId: 18 } };
  const actionLog = { url: `${extensionUrl}actionlog.html`, tab: { windowId: 18 } };
  const sidebar = { url: `${extensionUrl}sidebar.html` };
  expect(await background.receive("openSidebar", { metadata: { route: "ignored" } }, webPage)).toMatchObject({ error: expect.any(String) });
  expect(await background.receive("takeSidebarMetadata", { windowId: 18 }, webPage)).toMatchObject({ error: expect.any(String) });
  expect(await background.receive("openSidebar", { metadata: { route: "wrong" }, windowId: 19 }, actionLog)).toMatchObject({ error: expect.any(String) });
  await background.receive("openSidebar", { metadata: { route: "first" } }, actionLog);
  await background.receive("openSidebar", { metadata: { route: "latest" } }, actionLog);
  expect(await background.receive("takeSidebarMetadata", { windowId: 18 }, { ...sidebar, tab: { windowId: 19 } })).toMatchObject({ error: expect.any(String) });
  expect(await background.receive("takeSidebarMetadata", { windowId: 18 }, sidebar)).toEqual({ ok: true, result: { route: "latest" } });
});
