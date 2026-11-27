import { afterEach, expect, jest, test } from "bun:test";
import { tools as contentTools, parseToolInvocation, checkToolInvocationValidity } from "../../../dist/tools/monero-tools";
import { tools, ActionLogOpened, ActiveInvocations } from "../../../dist/xmr3";

const address = "4".repeat(95);
const origin = "https://merchant.example";
const fetch0 = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetch0; });

function invo() {
  return parseToolInvocation(`${origin}/pay#monerochan001_amount_0.1_address_${address}`, "", { href: `${origin}/checkout`, hostname: "merchant.example" } as Location)!;
}
function reply(value: unknown) {
  globalThis.fetch = (async () => Response.json(value)) as unknown as typeof fetch;
}

test("001 retains the merchant urls after successful address validation", async () => {
  const input = invo();
  reply({ valid_address: true, successUrl: `${origin}/return`, handoverUrl: `${origin}/handover` });
  expect(await checkToolInvocationValidity(input)).toBe("valid");
  expect(input.tool.payload).toMatchObject({ successUrl: `${origin}/return`, handoverUrl: `${origin}/handover` });
});

test("old 001 validation has no urls", async () => {
  const input = invo();
  reply({ valid_address: true });
  expect(await checkToolInvocationValidity(input)).toBe("valid");
  expect(input.tool.payload).not.toHaveProperty("successUrl");
});

test("a partial url pair is invalid", async () => {
  for (const body of [{ valid_address: true, successUrl: `${origin}/return` }, { valid_address: true, handoverUrl: `${origin}/handover` }]) {
    const input = invo(); reply(body); expect(await checkToolInvocationValidity(input)).toBe("invalid");
  }
});

test("cross-origin, credential, and non-http merchant urls are invalid", async () => {
  for (const [successUrl, handoverUrl] of [
    ["https://evil.example/return", `${origin}/handover`],
    [`${origin}/return`, "https://evil.example/handover"],
    [`https://user:pass@merchant.example/return`, `${origin}/handover`],
    [`${origin}/return`, "javascript:alert(1)"],
    ["", `${origin}/handover`],
  ]) {
    const input = invo();
    reply({ valid_address: true, successUrl, handoverUrl });
    expect(await checkToolInvocationValidity(input)).toBe("invalid");
    expect(input.tool.payload).not.toHaveProperty("handoverUrl");
  }
});

test("merchant handover route is available only from the main library entry", () => {
  expect(typeof (tools["001"].counterparty as any).execute_route).toBe("function");
  expect(contentTools["001"].counterparty).not.toHaveProperty("execute_route");
});

const fixture = await Bun.file("tests/tools/unit/scan-fixture.json").json();
function route(checkPayment: (scan: any) => boolean = () => true) {
  const accepted: string[] = [];
  const handle = (tools["001"].counterparty as any).execute_route({
    node_url: "https://node.example", primary_address: fixture.primary_address, view_key: fixture.secret_view_key,
    checkPayment, onAccepted: (scan: any) => { accepted.push(scan.tx_hash); },
  });
  const post = () => handle(new Request(`${origin}/handover`, { method: "POST", body: JSON.stringify({ tx_as_hex: fixture.tx_as_hex }) }));
  return { post, accepted };
}
function node(replies: unknown[]) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  }) as unknown as typeof fetch;
  return Object.assign(calls, { bodies });
}
const calls001 = (...paths: string[]) => paths.map((path) => "https://node.example/" + path);
// the answers of send_raw_transaction that a real node gave (lab note 89):
// a new transaction, and a transaction that the node has already in its pool or in a block.
const taken = () => ({ status: "OK", reason: "", not_relayed: false });
const known = () => ({ status: "OK", reason: "Not relayed", not_relayed: true });

test("the merchant sends the transaction to its node, and the OK of the node is the acceptance", async () => {
  for (const answer of [taken(), known()]) {
    const calls = node([answer]);
    const merchant = route((scan) => scan.outputs.some((output: any) => output.amount === fixture.expected.amount && output.payment_id === fixture.expected.payment_id));
    expect(await (await merchant.post()).json()).toEqual({ ok: true, tx_hash: fixture.expected.tx_hash });
    // one request. no lookup names the transaction to the node, and no chain tip is read.
    expect([...calls]).toEqual(calls001("send_raw_transaction"));
    expect(calls.bodies).toEqual([{ tx_as_hex: fixture.tx_as_hex }]);
    expect(merchant.accepted).toEqual([fixture.expected.tx_hash]);
  }
});

test("a transaction that the node refuses is not accepted, and the answer has the reason", async () => {
  for (const [answer, error] of [
    [{ status: "Failed", reason: "double spend", double_spend: true }, "transaction double spend"],
    [{ status: "Failed", reason: "fee too low", fee_too_low: true }, "fee too low"],
    [{ status: "Failed", reason: "" }, "transaction not accepted by node"],
    [new Response("busy", { status: 503 }), "node returned 503"],
  ] as const) {
    const calls = node([answer]);
    const merchant = route();
    expect(await (await merchant.post()).json()).toEqual({ ok: false, tx_hash: fixture.expected.tx_hash, error, ...(answer instanceof Response ? { submission_unknown: true } : {}) });
    expect([...calls]).toEqual(calls001("send_raw_transaction"));
    expect(merchant.accepted).toEqual([]);
  }
});

test("a lost node reply is a failed handover with the hash. the same bytes again are accepted, because the node has them", async () => {
  const calls = node([new Error("lost reply"), known()]);
  const merchant = route();
  expect(await (await merchant.post()).json()).toEqual({ ok: false, tx_hash: fixture.expected.tx_hash, error: "lost reply", submission_unknown: true });
  expect(merchant.accepted).toEqual([]);
  expect(await (await merchant.post()).json()).toEqual({ ok: true, tx_hash: fixture.expected.tx_hash });
  expect([...calls]).toEqual(calls001("send_raw_transaction", "send_raw_transaction"));
  expect(merchant.accepted).toEqual([fixture.expected.tx_hash]);
});

test("a route with no post-acceptance action does not need a no-op callback", async () => {
  const calls = node([taken()]);
  const handler = (tools["001"].counterparty as any).execute_route({
    node_url: "https://node.example", primary_address: fixture.primary_address, view_key: fixture.secret_view_key,
    checkPayment: () => true,
  });
  const response = await handler(new Request(`${origin}/handover`, { method: "POST", body: JSON.stringify({ tx_as_hex: fixture.tx_as_hex }) }));
  expect(await response.json()).toEqual({ ok: true, tx_hash: fixture.expected.tx_hash });
  expect([...calls]).toEqual(calls001("send_raw_transaction"));
});

test("merchant check can reject before the node is contacted", async () => {
  const calls = node([]);
  const merchant = route(() => false);
  expect(await (await merchant.post()).json()).toMatchObject({ ok: false, tx_hash: fixture.expected.tx_hash, error: "payment rejected" });
  expect([...calls]).toEqual([]);
});

function fakePort(url: string, id: number, frameId = 0) {
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<() => void>();
  return {
    name: "",
    sender: { url, tab: { id }, frameId },
    messages, disconnects,
    onMessage: { addListener: (fn: (value: unknown) => void) => { messages.add(fn); }, removeListener: (fn: (value: unknown) => void) => { messages.delete(fn); } },
    onDisconnect: { addListener: (fn: () => void) => { disconnects.add(fn); }, removeListener: (fn: () => void) => { disconnects.delete(fn); } },
    disconnect() { queueMicrotask(() => { for (const fn of [...disconnects]) fn(); }); },
    postMessage(_value: unknown) {},
  };
}

async function memoryLog(extensionMessageBus?: "background") {
  const state = new ActiveInvocations();
  return ActionLogOpened.create({ extensionMessageBus, backendInstance: {
    append: async (event) => { state.apply(event); },
    invocation: async (id) => state.invocation(id),
    invocations: async (status) => state.invocations(status),
  } });
}

async function paymentRig(options: { pendingValidation?: boolean; noCheck?: boolean; noHandover?: boolean; sendAddress?: string; frameId?: number; id?: number; sourcePath?: string; textLink?: boolean; closed?: boolean; holdMerchant?: boolean; disconnectOnPost?: boolean; refuse?: boolean; noise?: boolean; payerFails?: boolean; signFails?: boolean; lockFails?: boolean; acceptanceSaveFails?: boolean; payerSaveFails?: boolean; noConnect?: boolean } = {}) {
  const globals = globalThis as any;
  const oldChrome = globals.chrome;
  const oldBrowser = globals.browser;
  const ownNode = Promise.withResolvers<void>();
  const merchantReply = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<unknown>();
  const opened: string[] = [];
  const posts: { page: string; value: any }[] = [];
  let signs = 0;
  let payerSends = 0;
  let replacement: ReturnType<typeof fakePort> | undefined;
  let renewals = 0;
  const acceptedRows: number[] = [];
  const source = options.closed ? undefined : fakePort(`${origin}/${options.sourcePath ?? "checkout"}`, options.id ?? 42, options.frameId ?? 0);
  const wire = (port: ReturnType<typeof fakePort>) => {
    port.postMessage = (value) => {
      posts.push({ page: port.sender.url, value });
      if (options.disconnectOnPost && port === source) { port.disconnect(); return; }
      posted.resolve(value);
      void merchantReply.promise.then(() => {
        if (options.noise) for (const fn of [...port.messages]) fn({ kind: "unrelated" });
        for (const fn of [...port.messages]) fn({ ok: !options.refuse, error: options.refuse ? "payment rejected" : undefined, tx_hash: fixture.expected.tx_hash });
      });
    };
    return port;
  };
  if (source) wire(source);
  globals.browser = undefined;
  globals.chrome = { runtime: { sendMessage: async () => null }, tabs: { create: async ({ url }: { url: string }) => {
    opened.push(url);
    if (!options.noConnect) replacement = wire(fakePort(url, 99));
    return { id: 99 };
  } } };
  if (!options.holdMerchant) merchantReply.resolve();
  const log = await memoryLog();
  const input = invo();
  if (options.noCheck) Object.assign(input.tool.payload, { no_check: true });
  else if (!options.pendingValidation) {
    input.valid = "valid";
    if (!options.noHandover) Object.assign(input.tool.payload, { successUrl: `${origin}/return`, handoverUrl: `${origin}/handover` });
  }
  if (options.textLink) { input.linkText = input.link; input.link = "https://wrapper.example/pay"; input.found_in = "linkText"; }
  await log.toolCall(input);
  const wallet = { primary_address: address, tx_logs: options.signFails ? [] : [{ invocationId: input.invocation_id, signed_tx: "signed" }],
    async makeSignTransaction() {
      signs++;
      if (options.signFails) throw new Error("not enough funds");
      return { signedTx: "signed", txLogIndex: 0 };
    },
    async renewTransactionLock() { renewals++; },
    async recordHandoverAcceptance(index: number) {
      if (options.acceptanceSaveFails) throw new Error("acceptance save failed");
      acceptedRows.push(index);
    },
    async sendSignedTransaction(_signed: unknown, _invocationId: string, ready?: () => void) {
      if (options.lockFails) throw new Error("lock unavailable");
      payerSends++;
      ready?.();
      await ownNode.promise;
      if (options.payerFails) throw new Error("payer node offline");
      return { status: "OK", cache_error: options.payerSaveFails ? "outcome write failed" : undefined };
    },
  };
  const ctx = { log, getWallets: () => ({ wallets: [wallet] }), getPort: () => replacement ?? source };
  const running = tools["001"].worker.execute_run!(ctx, input.invocation_id, { wallet_to_send_from_pa: address, ...(options.sendAddress ? { address: options.sendAddress } : {}) });
  return {
    log, input, ctx, source, opened, posts, running, acceptedRows,
    get replacement() { return replacement; }, get signs() { return signs; }, get nodeEntered() { return payerSends > 0; }, get payerSends() { return payerSends; }, get renewals() { return renewals; },
    releaseNode: () => ownNode.resolve(), releaseMerchant: () => merchantReply.resolve(),
    async waitForPost() { await Promise.race([posted.promise, Bun.sleep(300).then(() => { throw new Error("handover did not start while payer node was held"); })]); },
    async close() {
      ownNode.resolve(); merchantReply.resolve();
      try { await running; } finally { globals.chrome = oldChrome; globals.browser = oldBrowser; }
    },
  };
}

test("changing the accepted destination does not disclose signed bytes to the original merchant", async () => {
  const rig = await paymentRig({ sendAddress: "8".repeat(95) });
  try {
    rig.releaseNode();
    await rig.running;
    expect(rig.signs).toBe(1);
    expect(rig.posts).toHaveLength(0);
    expect(rig.opened).toHaveLength(0);
  } finally { await rig.close(); }
});

for (const option of [
  { title: "the original merchant page", options: {}, replacement: false },
  { title: "a merchant link in link text", options: { textLink: true }, replacement: false },
  { title: "a previous merchant return page", options: { sourcePath: "return" }, replacement: false },
  { title: "a source tab with id zero", options: { id: 0 }, replacement: false },
  { title: "a source iframe", options: { frameId: 1 }, replacement: true },
  { title: "an unrelated page at the same origin", options: { sourcePath: "unrelated" }, replacement: true },
  { title: "a closed source page", options: { closed: true }, replacement: true },
]) {
  test(`handover selects ${option.title} correctly`, async () => {
    const rig = await paymentRig(option.options);
    try {
      await rig.waitForPost();
      expect(rig.opened).toHaveLength(option.replacement ? 1 : 0);
      expect(rig.posts).toHaveLength(1);
      expect(rig.posts[0]!.value).toMatchObject({ kind: "handover", payload: { handoverUrl: `${origin}/handover`, tx_as_hex: "signed" } });
      expect(rig.nodeEntered).toBe(true);
    } finally { await rig.close(); }
  });
}

test("a slow merchant does not block the payer node request", async () => {
  const rig = await paymentRig({ holdMerchant: true });
  try {
    await rig.waitForPost();
    expect(rig.nodeEntered).toBe(true);
    expect((await rig.log.invocation(rig.input.invocation_id))?.lastType).toBe("execute_start");
    rig.releaseNode(); rig.releaseMerchant();
    await rig.running;
    expect(rig.signs).toBe(1);
    expect((await rig.log.invocation(rig.input.invocation_id))?.events.filter((event) => event.type === "execute_result")).toHaveLength(1);
  } finally { await rig.close(); }
});

test("a source that disconnects during delivery gets one replacement tab", async () => {
  const rig = await paymentRig({ disconnectOnPost: true });
  try {
    await rig.waitForPost();
    expect(rig.opened).toHaveLength(1);
    expect(rig.posts).toHaveLength(2);
    expect(rig.posts[1]!.value.payload.tx_as_hex).toBe(rig.posts[0]!.value.payload.tx_as_hex);
    rig.releaseNode(); await rig.running;
    expect(rig.source!.messages.size).toBe(0);
    expect(rig.replacement!.messages.size).toBe(0);
    expect(rig.signs).toBe(1);
  } finally { await rig.close(); }
});

test("merchant refusal is not treated as a closed source page", async () => {
  const rig = await paymentRig({ refuse: true });
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    expect(rig.opened).toHaveLength(0);
    const last = (await rig.log.invocation(rig.input.invocation_id))!.events.at(-1)!;
    expect(last).toMatchObject({ ok: false, sent: true });
    expect(last.handover).toMatchObject({ ok: false, error: "payment rejected" });
  } finally { await rig.close(); }
});

test("unrelated port messages cannot complete a handover", async () => {
  const rig = await paymentRig({ noise: true });
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    expect((await rig.log.invocation(rig.input.invocation_id))!.events.at(-1)!.handover).toMatchObject({ ok: true });
  } finally { await rig.close(); }
});

test("a completed handover removes its response listeners", async () => {
  const rig = await paymentRig();
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    expect(rig.source!.messages.size).toBe(0);
    expect(rig.source!.disconnects.size).toBe(0);
  } finally { await rig.close(); }
});

test("an old port disconnect cannot delete the replacement port", async () => {
  const globals = globalThis as any;
  const oldChrome = globals.chrome; const oldBrowser = globals.browser;
  let connect!: (port: any) => void;
  globals.browser = undefined;
  globals.chrome = { runtime: { sendMessage: async () => null, onMessage: { addListener() {} }, onConnect: { addListener(fn: any) { connect = fn; } } } };
  try {
    const log = await memoryLog("background");
    const first = fakePort(`${origin}/checkout`, 42);
    const second = fakePort(`${origin}/return`, 99);
    first.name = second.name = "replacement-test";
    connect(first); connect(second);
    await Promise.resolve(); await Promise.resolve();
    expect(log.getPort("replacement-test")).toBe(second);
  } finally { globals.chrome = oldChrome; globals.browser = oldBrowser; }
});

async function results(rig: { log: any; input: any }) {
  return (await rig.log.invocation(rig.input.invocation_id))!.events.filter((event: any) => event.type === "execute_result");
}
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    jest.advanceTimersByTime(100);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

test("a failed payer node completes the tool when the merchant accepted the same bytes", async () => {
  const rig = await paymentRig({ payerFails: true });
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    const [result] = await results(rig);
    expect(result).toMatchObject({ ok: true, sent: true, error: "payer node offline", handover: { ok: true, tx_hash: fixture.expected.tx_hash } });
    expect(rig.acceptedRows).toEqual([0]);
    expect(rig.signs).toBe(1);
  } finally { await rig.close(); }
});

test("a failed payer node with a refused handover is a failed payment", async () => {
  const rig = await paymentRig({ payerFails: true, refuse: true });
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    const [result] = await results(rig);
    expect(result).toMatchObject({ ok: false, sent: false, error: "payer node offline", handover: { ok: false } });
  } finally { await rig.close(); }
});

test("a merchant without handover support has an ordinary successful send and no error", async () => {
  const rig = await paymentRig({ noHandover: true });
  try {
    rig.releaseNode(); await rig.running;
    const [result] = await results(rig);
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.handover == null).toBe(true);
    expect(rig.posts).toHaveLength(0);
    expect(rig.opened).toHaveLength(0);
  } finally { await rig.close(); }
});

test("001 waits for saved validation before signing or sending", async () => {
  const rig = await paymentRig({ pendingValidation: true });
  try {
    await Bun.sleep(0);
    const early = { signs: rig.signs, payerSends: rig.payerSends };
    reply({ valid_address: true, successUrl: `${origin}/return`, handoverUrl: `${origin}/handover` });
    rig.input.valid = await checkToolInvocationValidity(rig.input);
    await rig.log.toolCall(rig.input);
    rig.releaseNode();
    await rig.running;
    expect(early).toEqual({ signs: 0, payerSends: 0 });
    expect(rig.signs).toBe(1);
    expect(rig.posts).toHaveLength(1);
    expect((await results(rig))[0]).toMatchObject({ ok: true, sent: true, handover: { ok: true } });
  } finally { await rig.close(); }
});

test("001 does not sign when the pending validation rejects the address", async () => {
  const rig = await paymentRig({ pendingValidation: true });
  try {
    rig.input.valid = "invalid";
    await rig.log.toolCall(rig.input);
    rig.releaseNode();
    await rig.running;
    expect(rig.signs).toBe(0);
    expect(rig.payerSends).toBe(0);
    expect(rig.posts).toHaveLength(0);
    expect((await results(rig))[0]).toMatchObject({ ok: false, sent: false });
  } finally { await rig.close(); }
});

test("001 with no_check sends while validity is unverified", async () => {
  const rig = await paymentRig({ noCheck: true });
  try {
    rig.releaseNode();
    await rig.running;
    expect(rig.payerSends).toBe(1);
    expect(rig.posts).toHaveLength(0);
    expect((await results(rig))[0]).toMatchObject({ ok: true, sent: true });
  } finally { await rig.close(); }
});

test("001 validation timeout never signs and a late result does not reopen the call", async () => {
  jest.useFakeTimers();
  try {
    const rig = await paymentRig({ pendingValidation: true });
    const validationStarted = Promise.withResolvers<void>();
    const saveValidation = Promise.withResolvers<void>();
    const append = rig.log.append.bind(rig.log);
    rig.log.append = async (event) => {
      if (event.type === "validate_result") {
        validationStarted.resolve();
        await saveValidation.promise;
      }
      return append(event);
    };
    try {
      rig.input.valid = "valid";
      const checking = rig.log.toolCall(rig.input);
      await validationStarted.promise;
      rig.releaseNode();
      await advance(16_000);
      await rig.running;
      saveValidation.resolve();
      await checking;
      expect(rig.signs).toBe(0);
      expect((await rig.log.invocation(rig.input.invocation_id))!.status).toBe("failed");
      expect((await results(rig))[0]).toMatchObject({ ok: false, sent: false });
    } finally { saveValidation.resolve(); await rig.close(); }
  } finally { jest.useRealTimers(); }
});

// the states of a 001 call with a handover url (mids/mid-0003.md):
// done: a node has the transaction and the merchant has it. ok.
// handover failed: a node has it, the merchant does not. failed, sent, and the handover can be tried again.
// send failed: no node took it. failed, not sent.
test("paid, but the merchant did not get the transaction: a failed result that says sent", async () => {
  const rig = await paymentRig({ refuse: true });
  try {
    await rig.waitForPost(); rig.releaseNode(); await rig.running;
    const [result] = await results(rig);
    expect(result).toMatchObject({ ok: false, sent: true, handover: { ok: false, error: "payment rejected" } });
    expect(result.error).toBeUndefined();
    expect((await rig.log.invocation(rig.input.invocation_id))!.status).toBe("failed");
  } finally { await rig.close(); }
});

test("a handover retry that the merchant accepts makes the call done, with the same bytes and no new signature", async () => {
  const options = { refuse: true };
  const rig = await paymentRig(options);
  try {
    await rig.waitForPost(); rig.releaseNode(); await rig.running;
    options.refuse = false;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    const all = await results(rig);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ ok: true, sent: true, handover: { ok: true, tx_hash: fixture.expected.tx_hash } });
    expect(rig.posts.map((post) => post.value.payload.tx_as_hex)).toEqual(["signed", "signed"]);
    expect(rig.signs).toBe(1);
    expect((await rig.log.invocation(rig.input.invocation_id))!.status).toBe("done");
    // done is the end. another retry hands nothing over.
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    expect(rig.posts).toHaveLength(2);
    expect(await results(rig)).toHaveLength(2);
  } finally { await rig.close(); }
});

test("a handover retry that fails again stays a failed result that says sent", async () => {
  const rig = await paymentRig({ refuse: true });
  try {
    await rig.waitForPost(); rig.releaseNode(); await rig.running;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    const all = await results(rig);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ ok: false, sent: true, handover: { ok: false } });
  } finally { await rig.close(); }
});

test("a handover retry renews the generic input lock before delivery without signing again", async () => {
  const rig = await paymentRig({ refuse: true });
  try {
    await rig.waitForPost(); rig.releaseNode(); await rig.running;
    const before = rig.posts.length;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    expect(rig.renewals).toBe(1);
    expect(rig.posts).toHaveLength(before + 1);
    expect(rig.signs).toBe(1);
  } finally { await rig.close(); }
});

test("a signing failure never starts a handover", async () => {
  const rig = await paymentRig({ signFails: true });
  try {
    await rig.running;
    expect(rig.posts).toHaveLength(0);
    expect(rig.opened).toHaveLength(0);
    expect(rig.nodeEntered).toBe(false);
    const [result] = await results(rig);
    expect(result).toMatchObject({ ok: false, error: "not enough funds" });
    expect(result.handover).toBeUndefined();
  } finally { await rig.close(); }
});

test("a silent merchant page times out without blocking the payment result", async () => {
  jest.useFakeTimers();
  try {
    const rig = await paymentRig({ holdMerchant: true });
    try {
      for (let i = 0; i < 20 && !rig.posts.length; i++) await Promise.resolve();
      expect(rig.posts).toHaveLength(1);
      rig.releaseNode();
      await advance(15000);
      await rig.running;
      const [result] = await results(rig);
      expect(result).toMatchObject({ ok: false, sent: true, handover: { ok: false, error: "merchant handover timed out" } });
      expect(rig.source!.messages.size).toBe(0);
    } finally { await rig.close(); }
  } finally { jest.useRealTimers(); }
});

test("a merchant tab that never connects ends the handover with an error", async () => {
  jest.useFakeTimers();
  try {
    const rig = await paymentRig({ closed: true, noConnect: true });
    try {
      rig.releaseNode();
      await advance(10500);
      await rig.running;
      expect(rig.opened).toHaveLength(1);
      expect(rig.posts).toHaveLength(0);
      const [result] = await results(rig);
      expect(result).toMatchObject({ ok: false, sent: true, handover: { ok: false, error: "merchant page did not connect" } });
    } finally { await rig.close(); }
  } finally { jest.useRealTimers(); }
});

test("after a failed payer send, a retry hands over the same bytes and keeps sent false until acceptance", async () => {
  const options = { payerFails: true, refuse: true };
  const rig = await paymentRig(options);
  try {
    await rig.waitForPost();
    rig.releaseNode(); await rig.running;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    expect((await results(rig))[1]).toMatchObject({ ok: false, sent: false, handover: { ok: false } });
    options.refuse = false;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { retryHandover: true });
    expect((await results(rig))[2]).toMatchObject({ ok: true, sent: true, handover: { ok: true } });
    expect(rig.posts.map((post) => post.value.payload.tx_as_hex)).toEqual(["signed", "signed", "signed"]);
    expect(rig.renewals).toBe(2);
    expect(rig.acceptedRows).toEqual([0]);
    expect(rig.payerSends).toBe(1);
    expect(rig.signs).toBe(1);
  } finally { await rig.close(); }
});

test("a second execute of the same invocation does not sign again", async () => {
  const rig = await paymentRig();
  try {
    await rig.waitForPost();
    const during = tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { wallet_to_send_from_pa: address });
    rig.releaseNode(); await rig.running; await during;
    await tools["001"].worker.execute_run!(rig.ctx as any, rig.input.invocation_id, { wallet_to_send_from_pa: address });
    expect(rig.signs).toBe(1);
    expect(rig.posts).toHaveLength(1);
    expect(await results(rig)).toHaveLength(1);
  } finally { await rig.close(); }
});


test("a failed lock write keeps the signed bytes inside the payer wallet", async () => {
  const rig = await paymentRig({ lockFails: true });
  try {
    await rig.running;
    expect(rig.posts).toEqual([]);
    expect(rig.nodeEntered).toBe(false);
    expect((await results(rig))[0]).toMatchObject({ ok: false, sent: false, error: "lock unavailable" });
  } finally { await rig.close(); }
});


test("a cache write error does not turn known merchant acceptance into a failed payment", async () => {
  const rig = await paymentRig({ payerFails: true, acceptanceSaveFails: true });
  try {
    await rig.waitForPost();
    rig.releaseNode();
    await rig.running;
    expect((await results(rig))[0]).toMatchObject({
      ok: true, sent: true, handover: { ok: true, error: "Error: acceptance save failed" },
    });
  } finally { await rig.close(); }
});

test("payer acceptance survives a failed outcome write and keeps handover retry available", async () => {
  const rig = await paymentRig({ payerSaveFails: true, refuse: true });
  try {
    await rig.waitForPost();
    rig.releaseNode();
    await rig.running;
    expect((await results(rig))[0]).toMatchObject({
      ok: false, sent: true, error: "outcome write failed",
    });
  } finally { await rig.close(); }
});
