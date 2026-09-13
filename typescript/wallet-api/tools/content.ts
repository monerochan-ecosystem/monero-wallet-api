// do not import api.ts (indexedDB top-level await). tools/monero-tools.ts is 001+002 only.
import {
  checkToolInvocationValidity,
  parseToolInvocation,
  tools,
  type ToolId,
} from "./monero-tools";
import { sendToBackground } from "./globals";

type ExtensionRuntime = {
  sendMessage: (msg: unknown) => Promise<unknown>;
  connect: (info: { name: string }) => {
    onMessage: {
      addListener: (cb: (msg: unknown) => void) => void;
    };
  };
};
type ExtensionBrowser = { runtime: ExtensionRuntime };

declare global {
  var browser: ExtensionBrowser;
  var chrome: ExtensionBrowser;
}
if (typeof chrome !== "undefined" && typeof browser === "undefined") {
  globalThis.browser = chrome;
}

function processTargetLink(element: HTMLAnchorElement | null) {
  if (!element || element.tagName !== "A") return false;
  const href = element.href || element.getAttribute("href") || "";
  const text = element.textContent || element.innerText || "";
  return parseToolInvocation(href, text, location);
}

export function interceptToolLinkCallback(e: Event) {
  if (!(e.target instanceof Element)) return;
  const link = e.target.closest("a");
  const monerotoolLink = processTargetLink(link);
  if (!link || !monerotoolLink) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  void sendToBackground("toolCall", monerotoolLink).catch(() => {});
  void sendToBackground("openSidebar", null).catch(() => {});

  checkToolInvocationValidity(monerotoolLink).then((result) => {
    monerotoolLink.valid = result;
    void sendToBackground("toolCall", monerotoolLink).catch(() => {});
    const id = monerotoolLink.tool.tool_id as ToolId;
    tools[id]?.content.execute_deliver?.(monerotoolLink);
  });
}

export function installToolLinkEventInterception() {
  document.addEventListener("click", interceptToolLinkCallback, true);
  document.addEventListener("touchend", interceptToolLinkCallback, true);
  document.addEventListener("keydown", interceptToolLinkCallback, true);
}
