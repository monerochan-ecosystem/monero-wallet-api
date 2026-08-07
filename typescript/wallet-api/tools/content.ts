import {
  checkToolInvocationValidity,
  parseToolInvocation,
  potentialSuccessRedirect002,
  type ParsedMoneroToolInvocation,
} from "./monero-tools";
import type { ShareViewkeyPayload } from "./calls/002";

// extension runtime (chrome / browser polyfill). typed loosely so the lib does not need @types/chrome.
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
  // eslint-disable-next-line no-var
  var browser: ExtensionBrowser;
  // eslint-disable-next-line no-var
  var chrome: ExtensionBrowser;
}
if (typeof chrome !== "undefined" && typeof browser === "undefined") {
  globalThis.browser = chrome;
}

function sendMoneroToolEvent(payload: ParsedMoneroToolInvocation) {
  browser.runtime.sendMessage({ type: "toolCall", payload }).catch(() => {});
}

function sendOpenSideBarEvent() {
  browser.runtime
    .sendMessage({ type: "openSidebar", payload: null })
    .catch(() => {});
}

function sendShareViewkeyFAILEDEvent(payload: ShareViewkeyPayload) {
  browser.runtime
    .sendMessage({ type: "shareViewkeyFAILED", payload })
    .catch(() => {});
}

function receiveShareViewkeyEvent(
  msg: { type?: string; payload?: ShareViewkeyPayload },
  cb: (payload: ShareViewkeyPayload) => void,
) {
  if (msg.type === "shareViewkey" && msg.payload) {
    cb(msg.payload);
  }
}

function processTargetLink(element: HTMLAnchorElement | null) {
  if (!element || element.tagName !== "A") return false;

  const href = element.href || element.getAttribute("href") || "";
  const text = element.textContent || element.innerText || "";

  // matches if EITHER the href OR the visible text contains the tool link
  return parseToolInvocation(href, text, location);
}

export function interceptToolLinkCallback(e: Event) {
  if (!(e.target instanceof Element)) {
    return;
  }
  const link = e.target.closest("a");
  const monerotoolLink = processTargetLink(link);
  if (!link || !monerotoolLink) return;

  const eventType = e.type;
  const href = link.href || link.getAttribute("href") || "";

  e.preventDefault();
  e.stopImmediatePropagation();
  sendMoneroToolEvent(monerotoolLink);
  sendOpenSideBarEvent();

  console.log(
    `Intercepted ${eventType} (before any site code):`,
    href,
    "parse result:",
    monerotoolLink,
  );
  checkToolInvocationValidity(monerotoolLink).then((result) => {
    monerotoolLink.valid = result;
    sendMoneroToolEvent(monerotoolLink);
    if (monerotoolLink.tool.tool_id === "002") {
      const port = browser.runtime.connect({
        name: monerotoolLink.invocation_id,
      });

      port.onMessage.addListener((msg: unknown) => {
        receiveShareViewkeyEvent(
          msg as { type?: string; payload?: ShareViewkeyPayload },
          async (payload) => {
            const result = await potentialSuccessRedirect002(payload);
            if (result) {
              sendShareViewkeyFAILEDEvent(payload);
            }
          },
        );
      });
    }
  });
}

export function installToolLinkEventInterception() {
  document.addEventListener("click", interceptToolLinkCallback, true);
  document.addEventListener("touchend", interceptToolLinkCallback, true);
  document.addEventListener("keydown", interceptToolLinkCallback, true);
}
