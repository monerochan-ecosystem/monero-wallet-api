import { test, expect } from "bun:test";
import {
  checkToolInvocationValidity,
  parseToolInvocation,
  parseToolLink,
} from "../../../dist/tools/monero-tools";
import { deliverToolUrl } from "../../../dist/tools/content";
import { ActionLogOpened } from "../../../dist/actionlog/actionLogOpened";
import { ActiveInvocations } from "../../../dist/actionlog/actionLogTypes";

// the extension imports the parser from the ./tools export. test that build.
const ADDRESS =
  "47cYSGSjzWPX3KFEN9PaxT5zpWKgRtx568bazbGzt57ffBbUAQevjMk19sfZCrMB1RWHNJLbz1eKU63B77HpHwUVA6JGudr";
const page = {
  href: "https://shop.example.com/checkout",
  hostname: "shop.example.com",
} as Location;

test("legacy uri with tx_amount fills address and amount, no check", () => {
  expect(parseToolLink(`monero:${ADDRESS}?tx_amount=0.1`)).toEqual({
    tool_id: "001",
    payload: { address: ADDRESS, amount: "0.1", no_check: true },
  });
});

test("legacy uri without tx_amount fills only the address", () => {
  expect(parseToolLink(`monero:${ADDRESS}`)).toEqual({
    tool_id: "001",
    payload: { address: ADDRESS, amount: "", no_check: true },
  });
});

test("tx_amount between other parameters", () => {
  const uri = `monero:${ADDRESS}?tx_description=order%2042&tx_amount=1.5&recipient_name=shop`;
  expect(parseToolLink(uri)?.payload).toEqual({
    address: ADDRESS,
    amount: "1.5",
    no_check: true,
  });
});

test("a uri pasted in the url bar comes back percent-encoded in a search url", () => {
  // the omnibox has no url match for monero:, so enter searches. same url as brave search.
  const search = (q: string) =>
    `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=desktop`;
  expect(parseToolLink(search(`monero:${ADDRESS}?tx_amount=0.1`))?.payload).toEqual({
    address: ADDRESS,
    amount: "0.1",
    no_check: true,
  });
  expect(parseToolLink(search(`monero:${ADDRESS}`))?.payload).toEqual({
    address: ADDRESS,
    amount: "",
    no_check: true,
  });
});

test("the magic string is found wherever the browser put it", () => {
  // the browser chooses the parameter name. do not depend on it being q.
  const encoded = `monero%3A${ADDRESS}%3Ftx_amount%3D0.1`;
  expect(parseToolLink(`https://search.brave.com/search?query=${encoded}&source=desktop`)?.payload).toEqual({
    address: ADDRESS, amount: "0.1", no_check: true,
  });
  expect(parseToolLink(`https://example.com/redirect?target=${encoded}`)?.payload).toEqual({
    address: ADDRESS, amount: "0.1", no_check: true,
  });
  // when both forms appear, the plain one wins. one rule, no ordering logic.
  expect(parseToolLink(`https://example.com/?u=${encoded}&note=monero:${ADDRESS}`)).toEqual({
    tool_id: "001", payload: { address: ADDRESS, amount: "", no_check: true },
  });
});

test("an escaped uri that does not decode is refused, not scanned", () => {
  const marker = `monerochan001_amount_0.1_address_${ADDRESS}_no_check`;
  expect(parseToolLink(`https://example.com/?u=monero%3A%ZZ#${marker}`)).toBeNull();
});

test("legacy uri address shape and amount are not partial matches", () => {
  for (const address of [ADDRESS.slice(1), ADDRESS + "1", ADDRESS + "1".repeat(12)]) {
    expect(parseToolLink(`monero:${address}?tx_amount=1`)).toBeNull();
  }
  for (const amount of ["-1", "1oops", "1.2.3", "0.0000000000001"]) {
    expect(parseToolLink(`monero:${ADDRESS}?tx_amount=${amount}`)).toBeNull();
  }
  expect(parseToolLink(`MONERO:${ADDRESS}?tx_amount=0.000000000001`)?.payload).toEqual({
    address: ADDRESS, amount: "0.000000000001", no_check: true,
  });
  expect(parseToolLink(`monero:${ADDRESS + "1".repeat(11)}`)?.payload).toEqual({
    address: ADDRESS + "1".repeat(11), amount: "", no_check: true,
  });
});

test("legacy descriptions can contain the tool magic string", () => {
  const uri = `monero:${ADDRESS}?tx_amount=1&tx_description=monerochan001_merch`;
  expect(parseToolLink(uri)?.payload).toEqual({ address: ADDRESS, amount: "1", no_check: true });
  expect(parseToolLink(`https://search.brave.com/search?q=${encodeURIComponent(uri)}`)?.payload)
    .toEqual({ address: ADDRESS, amount: "1", no_check: true });
});

test("do not silently drop a payment id or choose between duplicate amounts", () => {
  expect(parseToolLink(`monero:${ADDRESS}?tx_amount=1&tx_payment_id=0123456789abcdef`)).toBeNull();
  expect(parseToolLink(`monero:${ADDRESS}?tx_amount=1&tx_amount=2`)).toBeNull();
});

test("a pasted legacy uri keeps the wrapping page as its context", () => {
  const link = `https://search.brave.com/search?q=${encodeURIComponent(`monero:${ADDRESS}?tx_amount=1`)}`;
  const invo = parseToolInvocation(link, "", { href: link, hostname: "search.brave.com" } as Location);
  expect(invo?.destination_domain).toBe("brave.com");
  expect(invo?.context_domain).toBe("brave.com");
  expect(invo?.context_href).toBe(link);
  expect(invo?.tool.payload).toEqual({ address: ADDRESS, amount: "1", no_check: true });
});

test("a malformed monero uri does not become a tool call", () => {
  // a broken monero: uri must fail closed. the marker inside it is not an invitation.
  const marker = `monerochan001_amount_0.1_address_${ADDRESS}_no_check`;
  expect(parseToolLink(`monero://[invalid]#${marker}`)).toBeNull();
  expect(
    parseToolLink(`https://search.brave.com/search?q=${encodeURIComponent(`monero://[invalid]#${marker}`)}`),
  ).toBeNull();
});

test("no legacy uri, no tool call", () => {
  expect(parseToolLink("https://example.com/")).toBeNull();
  expect(parseToolLink("monero:")).toBeNull();
  // a search for monero:wallet must not open the wallet. an address is 95 or 106 chars.
  expect(parseToolLink("https://search.brave.com/search?q=monero%3Awallet")).toBeNull();
  // a broken percent sequence must not throw in the click handler or the bridge
  expect(parseToolLink("https://example.com/100%")).toBeNull();
});

test("monerochan tool links parse as before", () => {
  expect(
    parseToolLink(`https://shop.example.com/#monerochan001_amount_0.1_address_${ADDRESS}`),
  ).toEqual({
    tool_id: "001",
    payload: { address: ADDRESS, amount: "0.1", no_check: false },
  });
  expect(
    parseToolLink(
      `https://shop.example.com/#monerochan001_amount_0.1_address_${ADDRESS}_no_check`,
    )?.payload,
  ).toEqual({ address: ADDRESS, amount: "0.1", no_check: true });
  expect(
    parseToolLink("https://shop.example.com/#monerochan002_create_and_share_viewkey_slot_3"),
  ).toEqual({ tool_id: "002", payload: { wallet_slot: 3 } });
});

test("a clicked legacy uri is an unverified 001 call with the click context", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("a legacy uri has no destination server to ask");
  }) as unknown as typeof fetch;
  try {
    const invo = parseToolInvocation(`monero:${ADDRESS}?tx_amount=0.1`, "pay", page);
    expect(invo?.tool).toEqual({
      tool_id: "001",
      payload: { address: ADDRESS, amount: "0.1", no_check: true },
    });
    expect(invo?.found_in).toBe("link");
    expect(invo?.context_domain).toBe("example.com");
    expect(invo?.context_href).toBe(page.href);
    expect(invo?.destination_domain).toBe("");
    expect(invo?.valid).toBe("unverified");
    expect(await checkToolInvocationValidity(invo!)).toBe("unverified");
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("direct delivery sends invocation before the async validity reply", async () => {
  const realChrome = globalThis.chrome;
  const realBrowser = globalThis.browser;
  const messages: { kind: string; payload: any }[] = [];
  let validated!: () => void;
  const finished = new Promise<void>((resolve) => { validated = resolve; });
  globalThis.browser = undefined as never;
  globalThis.chrome = { runtime: { sendMessage: async (msg: any) => {
    messages.push(msg);
    if (messages.length === 3) validated();
  } } } as never;
  try {
    expect(deliverToolUrl(`monero:${ADDRESS}?tx_amount=0.1`)).toBe(true);
    expect(messages.map((m) => m.kind)).toEqual(["toolCall", "openSidebar"]);
    await finished;
    expect(messages.map((m) => m.kind)).toEqual(["toolCall", "openSidebar", "toolCall"]);
    expect(messages[2]?.payload.valid).toBe("unverified");
    expect(messages[0]?.payload.tool.payload).toEqual({ address: ADDRESS, amount: "0.1", no_check: true });
  } finally {
    globalThis.chrome = realChrome;
    globalThis.browser = realBrowser;
  }
});

test("legacy call uses the existing 001 log and execute path", async () => {
  const active = new ActiveInvocations();
  const log = await ActionLogOpened.create({ backendInstance: {
    append: async (event) => { active.apply(event); },
    invocation: async (id) => active.invocation(id),
    invocations: async (status) => active.invocations(status),
  } });
  const sent: unknown[] = [];
  log.bindMco({ wallets: [{ primary_address: ADDRESS, makeSignSendTransaction: async (p: unknown) => { sent.push(p); } }] } as never);
  const invo = parseToolInvocation(`monero:${ADDRESS}`, "pay", page)!;
  await log.toolCall(invo);
  expect(log.getActiveByPermissions(["spend"])[0]?.no_check).toBe(true);
  expect((await log.invocation(invo.invocation_id))?.context_href).toBe(page.href);
  // no wallet, wasm, or node. only the last send method is a stub.
  await log.execute(invo.invocation_id, { amount: "0.4", wallet_to_send_from_pa: ADDRESS });
  expect(sent).toEqual([{ payments: [{ address: ADDRESS, amount: "400000000000" }], invocationId: invo.invocation_id }]);
  expect((await log.invocation(invo.invocation_id))?.ok).toBe(true);
  expect(log.getActiveByPermissions(["spend"])).toHaveLength(0);
});

test("legacy uri in the link text", () => {
  const invo = parseToolInvocation(
    "https://shop.example.com/pay",
    `monero:${ADDRESS}?tx_amount=2`,
    page,
  );
  expect(invo?.found_in).toBe("linkText");
  expect(invo?.tool.payload).toEqual({
    address: ADDRESS,
    amount: "2",
    no_check: true,
  });
});
