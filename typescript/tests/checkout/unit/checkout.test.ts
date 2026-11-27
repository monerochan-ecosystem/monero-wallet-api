import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const oldDatabase = Bun.env.CHECKOUT_DB;
Bun.env.CHECKOUT_DB = ":memory:";
const db = await import("../../../../standard-checkout/db");
const checkout = await import("../../../../standard-checkout/acceptance");
const { tools } = await import("../../../dist/xmr3");
const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });
afterAll(() => { if (oldDatabase === undefined) delete Bun.env.CHECKOUT_DB; else Bun.env.CHECKOUT_DB = oldDatabase; });

async function session(amount = "0.1337", confirmations = 10) {
  const row = (await db.createCheckoutSession(amount, crypto.randomUUID(), confirmations))[0];
  await db.updateCheckoutSessionAddress(row.session_id, "4".repeat(95));
  return (await db.getCheckoutSessionBySessionId(row.session_id))[0];
}
function scan(row: any, amount = "133700000000") {
  return { tx_hash: "a".repeat(64), unlock_time: "0", outputs: [{ amount, payment_id: String(row.id), index_in_transaction: 0, stealth_address: "b".repeat(64), subaddress_index: null }] };
}

test("checkout upgrades a saved session and keeps its transaction hash", async () => {
  const directory = resolve("test-data/checkout-upgrade");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const filename = `${directory}/checkout.sqlite`;
  const legacy = new Database(filename);
  const hash = "b".repeat(64);
  legacy.exec(`CREATE TABLE checkout_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT, amount TEXT NOT NULL, session_id TEXT NOT NULL,
    address TEXT, paid_status INTEGER NOT NULL DEFAULT 0, required_confirmations INTEGER NOT NULL DEFAULT 10,
    tx_confirmations INTEGER NOT NULL DEFAULT 0, tx_hash TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  legacy.run("INSERT INTO checkout_session (amount, session_id, tx_hash, paid_status, tx_confirmations) VALUES (?, ?, ?, 1, 10)", ["0.1337", "existing", hash]);
  legacy.close();

  Bun.env.CHECKOUT_DB = filename;
  try {
    const upgraded = await import(resolve("../standard-checkout/db.ts") + "?legacy-fixture") as typeof db;
    const [row] = await upgraded.getCheckoutSessionBySessionId("existing");
    expect(row).toMatchObject({ amount: "0.1337", tx_hash: hash, tracker_state: null });
    expect(checkout.statusMessage(row, checkout.storedStatus(row))).toBe("Payment received");
    const [confirmed] = await upgraded.updateTransactionStatus(row.id, hash, { confirmations: 1, block_height: 123, in_pool: false });
    expect(confirmed).toMatchObject({ tx_hash: hash, tx_block_height: 123, tx_confirmations: 1 });
  } finally {
    Bun.env.CHECKOUT_DB = ":memory:";
  }
});

test("checkout amount checks use exact atomic integers, not floating-point math", async () => {
  const row = await session("9007.199254740993");
  expect(checkout.checkoutMatches(scan(row, "9007199254740992"), row)).toBe(false);
  expect(checkout.checkoutMatches(scan(row, "9007199254740993"), row)).toBe(true);
});

test("wrong invoice, insufficient money, additional timelocks, and a replacement hash fail", async () => {
  const row = await session();
  expect(checkout.checkoutMatches(scan(row), row)).toBe(true);
  expect(checkout.checkoutMatches(scan(row, "1"), row)).toBe(false);
  expect(checkout.checkoutMatches(scan({ id: row.id + 1 }), row)).toBe(false);
  expect(checkout.checkoutMatches({ ...scan(row), unlock_time: "99999" }, row)).toBe(false);
  expect(checkout.checkoutMatches(scan(row), { ...row, tx_hash: "c".repeat(64) })).toBe(false);
});

test("real handover rejects a different destination, underpayment, and a wrong invoice before node contact", async () => {
  const { scanTransaction, makeTestKeyPair, ViewPair, convertBigIntAmount } = await import("../../../dist/xmr3");
  const fixture = await Bun.file("tests/tools/unit/scan-fixture.json").json();
  const primary = fixture.primary_address;
  const viewKey = fixture.secret_view_key;
  const correct = await ViewPair.create(primary, viewKey);
  const other = (await makeTestKeyPair()).view_key;
  const otherView = await ViewPair.create(other.mainnet_primary, other.view_key);
  const id = Number(fixture.expected.payment_id);
  const row = { ...(await session(convertBigIntAmount(BigInt(fixture.expected.amount)))), id, address: correct.makeIntegratedAddress(id) };
  const signed = { tx_as_hex: fixture.tx_as_hex, primary_address: primary, view_key: viewKey };
  expect(checkout.checkoutMatches(await scanTransaction(signed), row)).toBe(true);
  const wrongDestination = await scanTransaction({ ...signed, primary_address: other.mainnet_primary, view_key: other.view_key });
  expect(wrongDestination.outputs).toHaveLength(0);
  expect(checkout.checkoutMatches(wrongDestination, row)).toBe(false);
  let nodeCalls = 0;
  globalThis.fetch = (() => { nodeCalls++; throw new Error("rejected payments must not contact the node"); }) as unknown as typeof fetch;
  const cases = [
    { row: { ...row, amount: convertBigIntAmount(BigInt(fixture.expected.amount) + 1n) }, primary, viewKey },
    { row: { ...row, address: otherView.makeIntegratedAddress(id) }, primary: other.mainnet_primary, viewKey: other.view_key },
    { row: { ...row, id: id + 1, address: correct.makeIntegratedAddress(id + 1) }, primary, viewKey },
  ];
  for (const invalid of cases) {
    const response = await checkout.handoverRequest(new Request("https://merchant.test/handover", { method: "POST", body: JSON.stringify({ tx_as_hex: fixture.tx_as_hex }) }), invalid.row, {
      node_url: "https://node.test", primary_address: invalid.primary, view_key: invalid.viewKey,
    });
    expect(await response.json()).toMatchObject({ ok: false, error: "payment rejected" });
  }
  expect(nodeCalls).toBe(0);
});

test("the requested pre-node status is rendered with the exact visible ampersand", async () => {
  const row = { ...(await session()), tx_hash: "hash" };
  const { paymentStatusPage } = (await import("../page")).page;
  const text = await paymentStatusPage(checkout.statusMessage(row, null)).text();
  expect(text).toContain("Transaction is valid &amp; amount correct.");
});

test("address validation advertises handover on the same address route", async () => {
  const row = await session();
  const addressUrl = `https://merchant.example/monerochan001/${row.address}`;
  const response = await checkout.validateAddressRequest(new Request(addressUrl), row);
  const body = await response.json();
  expect(body).toMatchObject({ valid_address: true, successUrl: `https://merchant.example/return?checkoutId=${row.session_id}`, handoverUrl: addressUrl });
  const missing = await checkout.validateAddressRequest(new Request("https://merchant.example/monerochan001/missing"), undefined);
  expect(await missing.json()).toEqual({ valid_address: false });
});

test("a checkout hash is immutable and paid status stays set after a reorg", async () => {
  const row = await session("0.1337", 1);
  expect(await db.updateTxHash(row.id, "hash")).toHaveLength(1);
  expect(await db.updateTxHash(row.id, "different")).toHaveLength(0);
  await db.updateTransactionStatus(row.id, "hash", { in_pool: false, confirmations: 1, block_height: 100, block_hash: "old-block" });
  expect((await db.getCheckoutSessionBySessionId(row.session_id))[0].paid_status).toBe(1);
  await db.updateTransactionStatus(row.id, "hash", null);
  const after = (await db.getCheckoutSessionBySessionId(row.session_id))[0];
  expect(after).toMatchObject({ paid_status: 1, tx_confirmations: 0, tx_block_hash: null, tx_block_height: null, tx_hash: "hash" });
  expect(await db.releaseTxHash(row.id, "hash")).toHaveLength(0);
});

test("a receipt does not claim inclusion before the wallet scan finds it", async () => {
  const row = await session();
  const received = { ...row, tx_hash: "hash" };
  expect(checkout.statusMessage(received, null)).toBe("Transaction is valid & amount correct.");
  expect(checkout.statusMessage(received, { in_pool: true, confirmations: 0 })).toBe("Transaction is valid & amount correct.");
  expect(checkout.statusMessage(received, { in_pool: false, confirmations: 3, block_hash: "block", block_height: 100 })).toBe("Transaction confirming (3/10)");
  expect(checkout.statusMessage(received, { in_pool: false, confirmations: 10, block_hash: "block", block_height: 100 })).toBe("Payment received");
  expect(checkout.statusMessage({ ...received, paid_status: 1 }, { in_pool: false, confirmations: 1, block_height: 100 })).toBe("Payment received");
});

test("receipt status does not wait for either of two active merchant node requests", async () => {
  const row = await session();
  const original = tools["001"].counterparty.execute_route;
  const releases: (() => void)[] = [];
  const recorded: Promise<void>[] = [];
  const submits: Promise<Response>[] = [];
  tools["001"].counterparty.execute_route = (options) => {
    let ready!: () => void;
    recorded.push(new Promise<void>((resolve) => { ready = resolve; }));
    const gate = new Promise<void>((resolve) => releases.push(resolve));
    return async (req) => {
      await options.checkPayment(scan(row), req);
      ready();
      await gate;
      return Response.json({ ok: true });
    };
  };
  globalThis.fetch = (() => { throw new Error("status must not wait for the node"); }) as unknown as typeof fetch;
  try {
    const merchant = { node_url: "http://node", primary_address: "primary", view_key: "view" };
    submits.push(checkout.handoverRequest(new Request("https://merchant/handover"), row, merchant));
    submits.push(checkout.handoverRequest(new Request("https://merchant/handover"), row, merchant));
    await Promise.all(recorded);
    const received = (await db.getCheckoutSessionBySessionId(row.session_id))[0];
    expect(checkout.storedStatus(received)).toBeNull();
    releases[0]();
    await submits[0];
    expect(checkout.storedStatus(received)).toBeNull();
    releases[1]();
    await submits[1];
    expect(checkout.storedStatus(received)).toBeNull();
  } finally {
    for (const release of releases) release();
    await Promise.all(submits);
    tools["001"].counterparty.execute_route = original;
  }
});

function fakeRoute(answers: { hash: string; ok: boolean; gate?: Promise<void> }[]) {
  const original = tools["001"].counterparty.execute_route;
  tools["001"].counterparty.execute_route = (options) => async (req) => {
    const answer = answers.shift()!;
    const current = (await db.getCheckoutSessionBySessionId(new URL(req.url).searchParams.get("id")!))[0];
    if (!(await options.checkPayment({ ...scan(current), tx_hash: answer.hash }, req))) return Response.json({ ok: false, error: "payment rejected" });
    await answer.gate;
    if (answer.ok) await options.onAccepted?.({ ...scan(current), tx_hash: answer.hash }, req);
    return Response.json(answer.ok ? { ok: true, tx_hash: answer.hash } : { ok: false, tx_hash: answer.hash, error: "transaction double spend" });
  };
  return () => { tools["001"].counterparty.execute_route = original; };
}
const merchant = { node_url: "http://node", primary_address: "primary", view_key: "view" };
const handover = async (row: any, options = {}) => checkout.handoverRequest(new Request(`https://merchant/handover?id=${row.session_id}`), (await db.getCheckoutSessionBySessionId(row.session_id))[0], { ...merchant, ...options });
const saved = async (row: any) => (await db.getCheckoutSessionBySessionId(row.session_id))[0];
test("a handover the node rejects releases the checkout for another transaction", async () => {
  const row = await session();
  const restore = fakeRoute([{ hash: "a".repeat(64), ok: false }, { hash: "d".repeat(64), ok: true }]);
  try {
    expect(await (await handover(row)).json()).toMatchObject({ ok: false, error: "transaction double spend" });
    expect((await db.getCheckoutSessionBySessionId(row.session_id))[0].tx_hash).toBeNull();
    expect(await (await handover(row)).json()).toMatchObject({ ok: true, tx_hash: "d".repeat(64) });
    expect((await db.getCheckoutSessionBySessionId(row.session_id))[0].tx_hash).toBe("d".repeat(64));
  } finally { restore(); }
});

test("a failed handover keeps the hash while another handover of it is still running", async () => {
  const row = await session();
  const hold = Promise.withResolvers<void>();
  const restore = fakeRoute([{ hash: "a".repeat(64), ok: true, gate: hold.promise }, { hash: "a".repeat(64), ok: false }]);
  try {
    const first = handover(row);
    while (!(await db.getCheckoutSessionBySessionId(row.session_id))[0].tx_hash) await Bun.sleep(1);
    expect(await (await handover(row)).json()).toMatchObject({ ok: false });
    expect((await db.getCheckoutSessionBySessionId(row.session_id))[0].tx_hash).toBe("a".repeat(64));
    hold.resolve();
    expect(await (await first).json()).toMatchObject({ ok: true });
    expect((await db.getCheckoutSessionBySessionId(row.session_id))[0].tx_hash).toBe("a".repeat(64));
  } finally { hold.resolve(); restore(); }
});

test("standard checkout keeps paid after a reorg lowers confirmations or removes the payment", async () => {
  const directory = resolve("test-data/standard-checkout-paid-reorg");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const row = await session("0.1337", 2);
  const hash = "a".repeat(64);
  globalThis.fetch = (() => { throw new Error("must not contact node"); }) as unknown as typeof fetch;
  const tx = { amount: 133700000000n, payment_id: row.id, tx_hash: hash, confirmations: 1,
    outputs: [{ block_height: 100, payment_id: row.id, amount: 133700000000n }] } as Parameters<typeof checkout.syncWalletPayments>[1][number];
  await checkout.syncWalletPayments([row], [tx]);
  const confirming = await saved(row);
  await checkout.syncWalletPayments([confirming], []);
  const orphanedBeforePaid = await saved(row);
  await checkout.syncWalletPayments([orphanedBeforePaid], [{ ...tx, confirmations: 2 }]);
  const paid = await saved(row);
  await checkout.syncWalletPayments([paid], [tx]);
  const fewerConfirmations = await saved(row);
  await checkout.syncWalletPayments([fewerConfirmations], []);
  const orphanedAfterPaid = await saved(row);
  const message = (current: typeof paid) => checkout.statusMessage(current, checkout.storedStatus(current));
  const messages = [confirming, orphanedBeforePaid, paid, fewerConfirmations, orphanedAfterPaid].map(message);
  await Bun.write(directory + "/rows.json", JSON.stringify({ confirming, orphanedBeforePaid, paid, fewerConfirmations, orphanedAfterPaid, messages }, null, 2));
  expect(confirming).toMatchObject({ tx_hash: hash, tx_confirmations: 1, tx_block_height: 100, paid_status: 0 });
  expect(orphanedBeforePaid).toMatchObject({ tx_hash: hash, tx_confirmations: 0, tx_block_height: null, paid_status: 0 });
  expect(paid).toMatchObject({ tx_hash: hash, tx_confirmations: 2, tx_block_height: 100, paid_status: 1 });
  expect(fewerConfirmations).toMatchObject({ tx_hash: hash, tx_confirmations: 1, tx_block_height: 100, paid_status: 1 });
  expect(orphanedAfterPaid).toMatchObject({ tx_hash: hash, tx_confirmations: 0, tx_block_height: null, paid_status: 1 });
  expect(messages).toEqual([
    "Transaction confirming (1/2)", "Transaction is valid & amount correct.",
    "Payment received", "Payment received", "Payment received",
  ]);
});

test("standard checkout counts only live outputs for the invoice and keeps paid for a zero-confirmation target", async () => {
  const directory = resolve("test-data/checkout-scan-receipt");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const row = await session("0.1", 0);
  const output = { block_height: 100, payment_id: row.id, amount: 50_000_000_000n };
  const tx = { amount: output.amount * 3n, payment_id: row.id, tx_hash: "ab".repeat(32), confirmations: 1,
    outputs: [output, { ...output, burned: 0 }, { ...output, payment_id: row.id + 1 }] } as Parameters<typeof checkout.syncWalletPayments>[1][number];
  await checkout.syncWalletPayments([row], [tx]);
  const underpaid = await saved(row);
  tx.outputs.push({ ...tx.outputs[0]!, index_in_transaction: 3 });
  await checkout.syncWalletPayments([underpaid], [tx]);
  const paid = await saved(row);
  await checkout.syncWalletPayments([paid], []);
  const orphaned = await saved(row);
  await Bun.write(directory + "/rows.json", JSON.stringify({ underpaid, paid, orphaned }, null, 2));
  expect(underpaid).toMatchObject({ paid_status: 0, tx_hash: null });
  expect(paid).toMatchObject({ paid_status: 1, tx_hash: tx.tx_hash });
  expect(orphaned).toMatchObject({ paid_status: 1, tx_block_height: null, tx_confirmations: 0 });
});

test("walletless checkout offers only browser payment while standard checkout keeps address and QR", async () => {
  const { checkoutPage } = (await import("../page")).page;
  const row = await session();
  const walletless = await (await checkoutPage(row, "#browser-payment", true)).text();
  expect(walletless).toContain("pay with browser wallet");
  expect(walletless).toContain("#browser-payment");
  expect(walletless).toContain("/paymentstatus?checkoutId=");
  expect(walletless).not.toContain("<img");
  expect(walletless).not.toContain("Payment address");
  expect(walletless).not.toContain("Payment QR code");
  expect(walletless).not.toContain("Send exactly");
  expect(walletless).not.toContain("transaction handover is required");
  const standard = await (await checkoutPage(row, "#browser-payment")).text();
  expect(standard).toContain("<img");
  expect(standard).toContain("Payment address");
});

test("both checkouts and their status page use the black-and-white document style", async () => {
  const { checkoutPage, paymentStatusPage } = (await import("../page")).page;
  const row = await session();
  for (const browserOnly of [false, true]) {
    const page = await (await checkoutPage(row, "#real-link", browserOnly)).text();
    expect(page).toContain("Georgia");
    expect(page).not.toMatch(/#7c3aed|#5b21b6|radial-gradient|linear-gradient/i);
    expect(page).toContain("#real-link");
  }
  const status = paymentStatusPage("Transaction confirming (3/10)");
  expect(status.headers.get("Refresh")).toBe("1");
  expect(await status.text()).toContain("Transaction confirming (3/10)");
});

test("the shared checkout page retains the real 001 link", async () => {
  const row = await session();
  const { checkoutPage } = (await import("../page")).page;
  const marker = tools["001"].counterparty.make({ address: row.address!, amount: row.amount, no_check: false });
  const response = await checkoutPage(row, `/wallet_info?checkoutId=${row.session_id}#${marker}`);
  expect(await response.text()).toContain(marker);
});

test("a lost broadcast reply preserves the handover hash for the wallet scan", async () => {
  const row = await session();
  const hash = "a".repeat(64);
  const original = tools["001"].counterparty.execute_route;
  tools["001"].counterparty.execute_route = options => async req => {
    await options.checkPayment({ ...scan(row), tx_hash: hash }, req);
    return Response.json({ ok: false, tx_hash: hash, submission_unknown: true });
  };
  try {
    expect(await (await handover(row)).json()).toMatchObject({ submission_unknown: true });
    expect((await saved(row)).tx_hash).toBe(hash);
  } finally { tools["001"].counterparty.execute_route = original; }
});
