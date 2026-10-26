import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  DefaultConfirmationCallback,
  installToolLinkEventInterception,
} from "../../../wallet-api/tools/content";

const QUESTION = "Did you just follow a monerochan tool link?";
const ADDRESS = "47cYSGSjzWPX3KFEN9PaxT5zpWKgRtx568bazbGzt57ffBbUAQevjMk19sfZCrMB1RWHNJLbz1eKU63B77HpHwUVA6JGudr";
const TOOL_URL = `https://shop.example/#monerochan001_amount_0.1_address_${ADDRESS}_no_check`;
const globals = ["window", "document", "location", "browser", "chrome"] as const;
let original: Map<string, PropertyDescriptor | undefined>;
let confirm: ReturnType<typeof mock<(message: string) => boolean>>;
let messages: { kind: string; payload: unknown }[];

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
function setLocation(href: string) {
  const url = new URL(href);
  setGlobal("location", { href: url.href, hostname: url.hostname });
}

beforeEach(() => {
  original = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  messages = [];
  confirm = mock((_message: string) => false);
  const frame: { top?: unknown; confirm: typeof confirm } = { confirm };
  frame.top = frame;
  setGlobal("window", frame);
  setGlobal("document", { addEventListener: mock(() => {}) });
  setLocation(TOOL_URL);
  setGlobal("browser", {
    runtime: {
      sendMessage: async (message: { kind: string; payload: unknown }) => {
        messages.push(message);
        return null;
      },
    },
  });
  setGlobal("chrome", undefined);
});

afterEach(() => {
  for (const name of globals) {
    const descriptor = original.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("the default callback returns true when the user selects OK", () => {
  confirm.mockReturnValue(true);
  expect(DefaultConfirmationCallback(TOOL_URL)).toBe(true);
  expect(confirm).toHaveBeenCalledWith(QUESTION);
});

test("the default callback returns false when the user selects Cancel", () => {
  expect(DefaultConfirmationCallback(TOOL_URL)).toBe(false);
  expect(confirm).toHaveBeenCalledWith(QUESTION);
});

test("startup does not deliver a call after Cancel", () => {
  installToolLinkEventInterception();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(messages).toHaveLength(0);
});

test("startup delivers the same tool URL after OK", async () => {
  confirm.mockReturnValue(true);
  installToolLinkEventInterception();
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledTimes(1);
  const call = messages.find((message) => message.kind === "toolCall");
  expect(call?.payload).toMatchObject({ link: TOOL_URL });
});

test("an iframe does not show the question or deliver its URL", () => {
  Object.assign(window, { top: {} });
  confirm.mockReturnValue(true);
  installToolLinkEventInterception();
  expect(confirm).not.toHaveBeenCalled();
  expect(messages).toHaveLength(0);
});

test("a custom callback can reject a tool URL without a default prompt", () => {
  const reject = mock((_href: string) => false);
  installToolLinkEventInterception(reject);
  expect(reject).toHaveBeenCalledWith(TOOL_URL);
  expect(confirm).not.toHaveBeenCalled();
  expect(messages).toHaveLength(0);
});
