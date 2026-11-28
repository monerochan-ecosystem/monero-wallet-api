import { afterEach, expect, test } from "bun:test";
import { installBridge } from "../../../dist/tools/monero-tools";

const originalChrome = (globalThis as any).chrome;
const originalError = console.error;
afterEach(() => { (globalThis as any).chrome = originalChrome; console.error = originalError; });
function event() {
  const listeners: Function[] = [];
  return { listeners, addListener(fn: Function) { listeners.push(fn); }, fire(...args: unknown[]) { return listeners.map((fn) => fn(...args)); } };
}
function browser() {
  const startup = event(); const installed = event(); const message = event(); const navigate = event();
  const created: any[] = []; const removed: any[] = []; const panels: any[] = []; const behavior: any[] = []; const documents: any[] = [];
  let contexts: any[] = [];
  const api = {
    runtime: { getURL: (path: string) => `chrome-extension://wallet/${path}`,
      onStartup: startup, onInstalled: installed, onMessage: message,
      getContexts: async () => contexts,
    },
    offscreen: { createDocument: async (options: any) => { documents.push(options); contexts = [{ url: "background.html" }]; } },
    sidePanel: { setPanelBehavior: async (options: any) => { behavior.push(options); }, open: async (options: any) => { panels.push(options); } },
    tabs: { create: async (options: any) => { created.push(options); return { id: 42 }; }, remove: async (ids: number[]) => { removed.push(ids); } },
    webNavigation: { onBeforeNavigate: navigate },
  };
  (globalThis as any).chrome = api;
  console.error = () => {};
  return { api, startup, installed, message, navigate, created, removed, panels, behavior, documents };
}
const settle = () => Bun.sleep(1);

test("installBridge starts the offscreen document and installs browser handlers once", async () => {
  const b = browser();
  installBridge(); installBridge();
  await settle();
  expect(b.documents).toHaveLength(1);
  expect(b.documents[0]).toMatchObject({ url: "background.html", reasons: ["WORKERS"] });
  expect(b.startup.listeners).toHaveLength(1);
  expect(b.installed.listeners).toHaveLength(1);
  expect(b.message.listeners).toHaveLength(1);
  expect(b.navigate.listeners).toHaveLength(1);
  expect(b.behavior).toEqual([{ openPanelOnActionClick: true }]);
});

test("an existing offscreen document is not created twice", async () => {
  const b = browser();
  b.api.runtime.getContexts = async () => [{ url: "background.html" }];
  installBridge(); await settle();
  expect(b.documents).toHaveLength(0);
});

test("startup, install, and initial setup share one in-flight creation", async () => {
  const b = browser();
  const gate = Promise.withResolvers<any[]>();
  b.api.runtime.getContexts = () => gate.promise;
  installBridge(); b.startup.fire(); b.installed.fire();
  gate.resolve([]); await settle();
  expect(b.documents).toHaveLength(1);
});

test("a failed document creation can be retried on startup", async () => {
  const b = browser();
  let attempts = 0;
  const create = b.api.offscreen.createDocument;
  b.api.offscreen.createDocument = async (options: any) => { if (++attempts === 1) throw new Error("temporary failure"); await create(options); };
  installBridge(); await settle();
  b.startup.fire(); await settle();
  expect(attempts).toBe(2);
  expect(b.documents).toHaveLength(1);
});

test("the bridge opens the side panel in the sender tab window only", async () => {
  const b = browser(); installBridge(); await settle();
  b.message.fire({ kind: "openSidebar" }, { tab: { windowId: 18 } }, () => {});
  b.message.fire({ kind: "openSidebar" }, {}, () => {});
  b.message.fire({ kind: "openSidebar", payload: { metadata: { route: "form" } } }, { tab: { windowId: 18 } }, () => {});
  await settle();
  expect(b.panels).toEqual([{ windowId: 18 }]);
});

test("the bridge claims no reply channel for legacy opens, tool calls, or sidebar metadata", async () => {
  const b = browser(); installBridge(); await settle();
  const reply = () => { throw new Error("bridge must not reply"); };
  for (const kind of ["openSidebar", "execute", "toolCall", "takeSidebarMetadata", "sidebarMetadataChanged"])
    expect(b.message.fire({ kind }, { tab: { windowId: 18 } }, reply)).toEqual([undefined]);
  await settle();
  expect(b.panels).toEqual([{ windowId: 18 }]);
});

test("the bridge answers tabs.create with the new tab id", async () => {
  const b = browser(); installBridge(); await settle();
  const replies: unknown[] = [];
  expect(b.message.fire({ kind: "tabs.create", payload: { url: "https://merchant.example/return" } }, {}, (value: unknown) => replies.push(value))).toEqual([true]);
  await settle();
  expect(b.created).toEqual([{ url: "https://merchant.example/return" }]);
  expect(replies).toEqual([{ id: 42 }]);
});

for (const url of ["javascript:alert(1)", "chrome-extension://wallet/sidebar.html", "https://user:password@merchant.example/", "bad"]) {
  test(`tabs.create refuses an unsafe URL: ${url}`, async () => {
    const b = browser(); installBridge(); await settle();
    const replies: any[] = [];
    b.message.fire({ kind: "tabs.create", payload: { url } }, {}, (value: unknown) => replies.push(value));
    expect(b.created).toHaveLength(0);
    expect(replies[0]).toMatchObject({ error: "invalid tab url" });
  });
}

test("a direct tool link opens the existing confirmation page, not a second tool implementation", async () => {
  const b = browser(); installBridge(); await settle();
  const url = `https://merchant.example/#monerochan001_amount_0.1_address_${"4".repeat(95)}`;
  b.navigate.fire({ frameId: 0, tabId: 99, url });
  await settle();
  expect(b.created).toEqual([{ url: `chrome-extension://wallet/toolconfirm.html?confirmToolUrl=${encodeURIComponent(url)}` }]);
  expect(b.removed).toEqual([[99]]);
});

test("a wallet with other page names gives them in the options", async () => {
  const b = browser();
  installBridge({ backgroundUrl: "offscreen.html", confirmationPage: "confirm.html" });
  await settle();
  expect(b.documents[0]).toMatchObject({ url: "offscreen.html" });
  const url = `https://merchant.example/#monerochan001_amount_0.1_address_${"4".repeat(95)}`;
  b.navigate.fire({ frameId: 0, tabId: 99, url });
  await settle();
  expect(b.created).toEqual([{ url: `chrome-extension://wallet/confirm.html?confirmToolUrl=${encodeURIComponent(url)}` }]);
});

test("ordinary navigation and subframes do not open a confirmation page", async () => {
  const b = browser(); installBridge(); await settle();
  b.navigate.fire({ frameId: 0, tabId: 99, url: "https://merchant.example/checkout" });
  b.navigate.fire({ frameId: 1, tabId: 99, url: `https://merchant.example/#monerochan001_amount_0.1_address_${"4".repeat(95)}` });
  await settle();
  expect(b.created).toHaveLength(0);
});

// content scripts are classic scripts, and service workers refuse top-level await.
// io/indexedDB opens indexedDB with a top-level await, so an iife build of a graph with it throws.
test("the tools entries bundle as classic scripts without the indexedDB shim", async () => {
  for (const entry of ["monero-tools", "content"]) {
    const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../../../dist/tools/${entry}.js`], target: "browser", format: "iife" });
    const code = await build.outputs[0]!.text();
    expect(code).not.toContain("IndexedDBBun");
    expect(() => new Function(code)).not.toThrow();
  }
});
