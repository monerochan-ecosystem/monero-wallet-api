import { parseToolLink } from "./monero-tools";

type BridgeBrowser = {
  runtime: {
    getURL(path: string): string;
    getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;
    onStartup: { addListener(listener: () => void): void };
    onInstalled: { addListener(listener: () => void): void };
    onMessage: { addListener(listener: (
      message: { kind?: string; payload?: { url?: string } },
      sender: { tab?: { windowId?: number } },
      reply: (value: unknown) => void,
    ) => boolean | void): void };
  };
  offscreen: { createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<unknown> };
  sidePanel: { setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<unknown>; open(options: { windowId: number }): Promise<unknown> };
  tabs: { create(options: { url: string }): Promise<{ id?: number }>; remove(ids: number[]): Promise<unknown> };
  webNavigation: { onBeforeNavigate: { addListener(listener: (details: { frameId: number; tabId: number; url: string }) => void): void } };
};
const installed = new WeakSet<object>();

// call from the MV3 service worker entrypoint. 
export function installBridge(options: { backgroundUrl?: string; confirmationPage?: string } = {}): void {
  const api = (globalThis as unknown as { chrome?: BridgeBrowser }).chrome;
  if (!api?.offscreen || !api.sidePanel) throw new Error("installBridge must run in a Chrome extension service worker");
  // a second call does nothing. two sets of listeners would open each tab twice.
  if (installed.has(api)) return;
  installed.add(api);
  let creating: Promise<unknown> | undefined;
  async function setupOffscreenDocument() {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await api!.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts.length) return;
      await api!.offscreen.createDocument({
        url: options.backgroundUrl || "background.html", reasons: ["WORKERS"],
        justification: "worker for wallet syncing and scanning utxos.",
      });
    })();
    try { await creating; } finally { creating = undefined; }
  }
  const ensureDocument = () => { void setupOffscreenDocument().catch((error) => console.error("offscreen setup failed", error)); };
  api.runtime.onStartup.addListener(ensureDocument);
  api.runtime.onInstalled.addListener(ensureDocument);
  ensureDocument();
  void api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

  api.runtime.onMessage.addListener((message, sender, reply) => {
    // the 001 handover opens the merchant success page with this when it cannot use the page that made the call. ( because it was closed )
    // the offscreen document has no chrome.tabs.
    if (message?.kind === "tabs.create") {
      try {
        const url = new URL(message.payload?.url || "");
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("invalid tab url");
        void api.tabs.create({ url: url.href }).then((tab) => reply({ id: tab.id }), (error) => reply({ error: String(error) }));
        return true;
      } catch { reply({ error: "invalid tab url" }); return; }
    }
    if (message?.kind !== "openSidebar" || sender.tab?.windowId == null) return;
    void api.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
  });

  api.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0 || !parseToolLink(details.url)) return;
    const url = api.runtime.getURL(options.confirmationPage || "toolconfirm.html") + `?confirmToolUrl=${encodeURIComponent(details.url)}`;
    void api.tabs.create({ url }).then(() => api.tabs.remove([details.tabId])).catch((error) => console.error("tool confirmation failed", error));
  });
}
