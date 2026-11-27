import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { makeTestKeyPair } from "../../../dist/xmr3";

const run = Bun.env.RUN_WALLETLESS_REGTEST === "1" ? test : test.skip;
const directory = resolve("test-data/walletless-checkout-functional");
// the regtest node starts and stops like in tests/acceptance/reorg_handling.test.ts
const MONEROD_PATH = "tests/moneronode/monerod";
const RPC_PORT = 18081;
async function killLeftoverMonerod(): Promise<void> {
  await Bun.$`pgrep monerod && kill -9 $(pgrep monerod) 2>/dev/null; echo "monerod processes remaining: $(pgrep monerod | wc -l)"`;
}
async function stopNode(proc: Bun.Subprocess): Promise<void> {
  proc.kill(9);
  await proc.exited;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function post(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`http ${response.status}: ${url}`);
  return response.json();
}
async function rpc(url: string, method: string, params = {}): Promise<any> {
  const data = await post(`${url}/json_rpc`, { jsonrpc: "2.0", id: "0", method, params });
  if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
  return data.result;
}
async function waitFor(check: () => Promise<unknown>) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("service did not become ready");
}
async function stop(child: Bun.Subprocess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited) child.kill("SIGKILL");
  await child.exited;
}

run("walletless HTTP checkout follows handed-over payments with get_block through a restricted RPC interface without transaction-specific node lookups", async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(`${directory}/wallets`, { recursive: true });
  await mkdir(`${directory}/server`, { recursive: true });
  // the test controls the node. the checkout gets a proxy with restricted methods only.
  const node = `http://127.0.0.1:${RPC_PORT}`;
  const wallet = `http://127.0.0.1:${await freePort()}`;
  const port = await freePort();
  const page = `http://127.0.0.1:${port}`;
  const children: Bun.Subprocess[] = [];
  let monerod: Bun.Subprocess | undefined;
  // record every permitted checkout request and block position.
  const requests: string[] = [];
  const names = (from = 0) => requests.slice(from).map((request) => request.split(" ")[0]);
  const checks: Record<string, unknown> = {};
  let nodeUnavailable = false;
  let submissionPending = false;
  let releaseSubmission!: () => void;
  const submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve; });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    let call: { method?: string; params?: { height?: number; hash?: string } } = {};
    try { call = JSON.parse(body); } catch {}
    if (path !== "/send_raw_transaction" && !["get_info", "get_block_headers_range", "get_block"].includes(call.method ?? "")) {
      return Response.json({ error: { code: -32601, message: "Method not found" } });
    }
    requests.push(call.method === "get_block" ? `get_block ${call.params?.height ?? call.params?.hash}` : call.method || path);
    if (nodeUnavailable) return new Response("node unavailable", { status: 503 });
    // the first handover waits here, so the test can look at the checkout before the node has the transaction
    if (path === "/send_raw_transaction" && !submissionPending) {
      submissionPending = true;
      await submissionGate;
    }
    return fetch(node + path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } });
  const launch = (name: string, args: string[], extra: Record<string, unknown> = {}) => {
    const child = Bun.spawn(args, { stdin: "ignore", stdout: Bun.file(`${directory}/${name}-stdout.log`), stderr: Bun.file(`${directory}/${name}-stderr.log`), ...extra });
    children.push(child);
    return child;
  };
  try {
    await killLeftoverMonerod();
    monerod = launch("node", [
      MONEROD_PATH,
      "--regtest", "--offline", "--fixed-difficulty", "1",
      "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(RPC_PORT),
      "--non-interactive",
    ]);
    await waitFor(async () => (await rpc(node, "get_info")).height);
    // the checkout interface cannot mine
    await expect(rpc(`http://127.0.0.1:${proxy.port}`, "generateblocks", { amount_of_blocks: 1, wallet_address: "x" })).rejects.toThrow("Method not found");
    launch("wallet", [
      resolve(Bun.env.MONERO_WALLET_RPC_PATH || "../../monero-playground/monero-wallet-rpc"),
      "--daemon-address", node, "--trusted-daemon", "--allow-mismatched-daemon-version",
      "--wallet-dir", `${directory}/wallets`, "--rpc-bind-ip", "127.0.0.1",
      "--rpc-bind-port", new URL(wallet).port, "--disable-rpc-login",
      "--log-file", `${directory}/wallet.log`, "--non-interactive",
    ]);
    await waitFor(() => rpc(wallet, "get_version"));
    await rpc(wallet, "create_wallet", { filename: "sender", password: "", language: "English" });
    const sender = (await rpc(wallet, "get_address")).address;
    const merchant = await makeTestKeyPair();
    const merchantAddress = merchant.view_key.mainnet_primary;
    const serverSource = resolve("../walletless-checkout/checkout.ts");
    // production mode, like a deploy. dev mode would write .mininext-*.html into standard-checkout.
    const startServer = (name: string, confirmations: number) => launch(name, [process.execPath, serverSource], { cwd: `${directory}/server`, env: { ...Bun.env, NODE_ENV: "production",
      MONERO_PRIMARY_ADDRESS: merchantAddress, MONERO_VIEW_KEY: merchant.view_key.view_key,
      MONERO_NODE_URL: `http://127.0.0.1:${proxy.port}`, CHECKOUT_PORT: String(port), CHECKOUT_DB: "checkout.sqlite", REQUIRED_CONFIRMATIONS: String(confirmations),
    } });
    let server = startServer("checkout", 3);
    await waitFor(async () => (await fetch(page)).ok);
    const newSession = async () => new URL((await fetch(page + "/newsession")).url).searchParams.get("checkoutId")!;
    const sessionId = await newSession();
    const database = new Database(`${directory}/server/checkout.sqlite`, { readonly: true });
    const row = (id = sessionId) => database.query("SELECT * FROM checkout_session WHERE session_id = ?").get(id) as any;
    const status = (id = sessionId) => fetch(page + "/paymentstatus?checkoutId=" + id).then((response) => response.text());
    const mine = (count: number, to = sender) => rpc(node, "generateblocks", { amount_of_blocks: count, wallet_address: to });
    const pop = (count: number) => post(node + "/pop_blocks", { nblocks: count });
    const top = async () => (await rpc(node, "get_info")).height - 1;
    // the row changes with no status request. the periodic tracker pass does that.
    const rowBecomes = (fields: Record<string, unknown>, id = sessionId) => waitFor(async () => Object.entries(fields).every(([key, value]) => row(id)[key] === value));
    // the node puts a transaction into a block only after its relay step. that step runs some milliseconds after the answer.
    const inPool = (hash: string) => waitFor(async () => (await post(node + "/get_transaction_pool", {})).transactions?.some((tx: any) => tx.id_hash === hash && tx.relayed));
    const isInPool = async (hash: string) =>
      ((await post(node + "/get_transaction_pool", {})).transactions ?? []).some((tx: { id_hash: string }) => tx.id_hash === hash);
    const assertMined = async (hash: string, height: number, confirmations: number) => {
      const block = await rpc(node, "get_block", { height });
      expect(block.tx_hashes).toContain(hash);
      expect(await top() - height + 1).toBe(confirmations);
    };
    // each checkout stores its individual state, including its search position
    const savedState = (id = sessionId) => row(id).tracker_state ?? "";
    const trackerState = (id = sessionId) => JSON.parse(savedState(id) || "{}");
    // results.json gets the row, the size of the saved state and the node calls of each step, in order
    let checked = 0;
    const check = (name: string, id = sessionId, extra = {}) => { checks[name] = { ...row(id), ...extra, savedStateBytes: savedState(id).length, nodeCalls: requests.slice(checked) }; checked = requests.length; };

    // 1. no payment, no node call. the tracker is idle.
    expect(await status()).toContain("Waiting for payment");
    await Bun.sleep(2500);
    expect(requests).toHaveLength(0);
    check("beforeHandover");
    await mine(177);
    await rpc(wallet, "refresh");
    const outputs = (await rpc(wallet, "incoming_transfers", { transfer_type: "available", verbose: true })).transfers.filter((output: any) => output.key_image);
    const sign = (id: string, key_image: string) => rpc(wallet, "sweep_single", { address: row(id).address, key_image, get_tx_hex: true, do_not_relay: true, priority: 1, ring_size: 16 });
    const signed = await sign(sessionId, outputs[0].key_image);
    // signed 3 blocks before the handover: step 5 mines this transaction 3 blocks below the handover tip,
    // and a ring member that is still locked at that height would keep it out of the block.
    await mine(3);
    expect(await isInPool(signed.tx_hash)).toBe(false);
    const handoverTop = await top();

    // 2. the handover. the receipt shows before the node has the transaction.
    const handover = async (id = sessionId, tx = signed) => {
      const addressUrl = page + "/monerochan001/" + row(id).address;
      const validation = await fetch(addressUrl).then((response) => response.json());
      expect(validation).toMatchObject({
        valid_address: true, successUrl: page + "/return?checkoutId=" + id, handoverUrl: addressUrl,
      });
      return post(validation.handoverUrl, { tx_as_hex: tx.tx_blob });
    };
    const submitting = handover();
    await waitFor(async () => submissionPending);
    expect(row()).toMatchObject({ tx_hash: signed.tx_hash, paid_status: 0, tx_confirmations: 0, tx_block_height: null });
    expect(await status()).toContain("Transaction is valid &amp; amount correct.");
    expect(await isInPool(signed.tx_hash)).toBe(false);
    check("beforeNodeAcceptance", sessionId, { submissionPending: true });
    releaseSubmission();
    expect(await submitting).toMatchObject({ ok: true, tx_hash: signed.tx_hash });
    // the handover sends the bytes in one request. it works on a restricted port, where a pool lookup would say "missing".
    const trackerCalls = ["get_info", "get_block"];
    expect(names().filter((name) => !trackerCalls.includes(name))).toEqual(["/send_raw_transaction"]);
    expect(row()).toMatchObject({ tx_hash: signed.tx_hash, tx_block_height: null, tx_confirmations: 0, paid_status: 0 });
    expect(await status()).toContain("Transaction accepted by node. Waiting for a block");
    // the tracker reads the chain and saves the completed search position
    await waitFor(async () => trackerState().position?.height === handoverTop);
    // the first look also reads blocks below the handover tip. a transaction can be there (steps 5 and 9).
    expect(names().filter((name) => name === "get_block").length).toBeGreaterThanOrEqual(10);
    check("accepted");

    // 3. confirmations come in with no status request
    await inPool(signed.tx_hash);
    await mine(1);
    await rowBecomes({ tx_confirmations: 1, tx_block_height: handoverTop + 1 });
    expect(await status()).toContain("Transaction confirming (1/3)");
    check("confirming");

    // 4. a reorg removes the block. acceptance remains, but no block is known.
    await pop(1);
    await rowBecomes({ tx_confirmations: 0, tx_block_height: null });
    expect(await status()).toContain("Transaction accepted by node. Waiting for a block");
    check("reorgToAccepted");

    // 5. a deeper reorg. the new chain has the transaction 3 blocks below the place where the search was.
    await pop(3);
    await mine(2, merchantAddress);
    await assertMined(signed.tx_hash, handoverTop - 2, 2);
    await rowBecomes({ tx_confirmations: 2, tx_block_height: handoverTop - 2 });
    check("afterReorgBelowTheSearch");

    // 6. the next block still counts it. paid at the required count.
    await mine(1, merchantAddress);
    await rowBecomes({ tx_confirmations: 3, paid_status: 1 });
    expect(await status()).toContain("Payment received");
    // each pass checks the top; changed chains require updated block headers
    expect(names().filter((name) => name === "get_info").length).toBeGreaterThan(1);
    check("paid");

    // 7. a paid checkout is final and costs no node call
    await Bun.sleep(1500);
    const afterPaid = requests.length;
    await pop(1);
    await Bun.sleep(2500);
    expect(await status()).toContain("Payment received");
    expect(row()).toMatchObject({ paid_status: 1, tx_confirmations: 3 });
    expect(requests).toHaveLength(afterPaid);
    check("paidIsFinal");
    await mine(1);

    // 8. a second checkout. a node outage does not lose it.
    const second = await newSession();
    const signedSecond = await sign(second, outputs[1].key_image);
    expect(await handover(second, signedSecond)).toMatchObject({ ok: true });
    await inPool(signedSecond.tx_hash);
    nodeUnavailable = true;
    await mine(1);
    await Bun.sleep(2500);
    expect(row(second)).toMatchObject({ tx_confirmations: 0, paid_status: 0 });
    expect(await status(second)).not.toContain("Payment received");
    check("nodeOutage", second);
    nodeUnavailable = false;
    expect(await status(second)).toContain("Transaction confirming (1/3)");
    await rowBecomes({ tx_confirmations: 1 }, second);
    check("afterNodeOutage", second);

    // 9. a transaction that is in a block before the handover: the wallet sent it itself and hands it over late.
    // the chain does not move after this handover. the tracker finds the block and counts.
    const third = await newSession();
    const signedThird = await sign(third, outputs[2].key_image);
    expect(await post(node + "/send_raw_transaction", { tx_as_hex: signedThird.tx_blob })).toMatchObject({ status: "OK" });
    await inPool(signedThird.tx_hash);
    await mine(1);
    const thirdBlock = await top();
    await mine(4);
    await assertMined(signedThird.tx_hash, thirdBlock, 5);
    await rowBecomes({ paid_status: 1 }, second);
    const sent = () => names().filter((name) => name === "/send_raw_transaction").length;
    const sentBefore = sent();
    const lateTop = await top();
    // the node has the transaction in a block. it answers the send with OK, and that is the acceptance.
    expect(await handover(third, signedThird)).toMatchObject({ ok: true, tx_hash: signedThird.tx_hash });
    expect(sent()).toBe(sentBefore + 1);
    // the open checkout page reloads its status each second (Refresh: 1). each status request is a tracker pass.
    await status(third);
    await rowBecomes({ tx_block_height: thirdBlock, tx_confirmations: 5, paid_status: 1 }, third);
    expect(await top()).toBe(lateTop);
    expect(await status(third)).toContain("Payment received");
    check("inChainBeforeHandover", third);

    // 10. the new server resumes a saved search after restart.
    const fourth = await newSession();
    const signedFourth = await sign(fourth, outputs[3].key_image);
    expect(await handover(fourth, signedFourth)).toMatchObject({ ok: true });
    await inPool(signedFourth.tx_hash);
    const stopTop = await top();
    // the status request of the page is the first pass. the saved position proves that the search reached the tip
    await status(fourth);
    await waitFor(async () => trackerState(fourth).position?.height === stopTop);
    expect(trackerState(fourth).search_from_height).toBe(stopTop - 20);
    expect(row(fourth)).toMatchObject({ tx_confirmations: 0, tx_block_height: null });
    await stop(server);
    // a block while the server is off. it takes the transaction from the pool.
    await mine(1);
    const beforeRestart = requests.length;
    // new checkouts of this server need 40 confirmations. the open one keeps its 3.
    server = startServer("checkout-restarted", 40);
    await rowBecomes({ tx_confirmations: 1, tx_block_height: stopTop + 1, paid_status: 0 }, fourth);
    // the tracker checks the saved block before it advances.
    expect(requests.slice(beforeRestart)).toContain(`get_block ${stopTop}`);
    await mine(2);
    await rowBecomes({ tx_confirmations: 3, paid_status: 1 }, fourth);
    const afterRestart = requests.slice(beforeRestart);
    expect(afterRestart.filter((request) => request.startsWith("get_block ")).every((request) => Number(request.split(" ")[1]) >= stopTop)).toBe(true);
    expect(afterRestart.length).toBeLessThan(20);
    check("afterRestart", fourth, { requestsAfterRestart: afterRestart.length });

    // 11. a reorg of 25 blocks replaces blocks already searched.
    await waitFor(async () => (await fetch(page)).ok);
    const fifth = await newSession();
    const signedFifth = await sign(fifth, outputs[4].key_image);
    expect(await handover(fifth, signedFifth)).toMatchObject({ ok: true });
    await inPool(signedFifth.tx_hash);
    expect(trackerState(fifth).search_from_height).toBe(await top() - 20);
    await mine(1);
    const fifthBlock = await top();
    await mine(24);
    await rowBecomes({ tx_confirmations: 25, tx_block_height: fifthBlock, paid_status: 0 }, fifth);
    // an unchanged top costs one get_info request and no database write
    await Bun.sleep(1500);
    const quietFrom = requests.length;
    const version = () => (database.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    const versionBefore = version();
    await Bun.sleep(3000);
    const quiet = requests.slice(quietFrom);
    expect(quiet.length).toBeGreaterThanOrEqual(2);
    expect(quiet.length).toBeLessThanOrEqual(4);
    expect(quiet.every((request) => request === "get_info")).toBe(true);
    expect(version()).toBe(versionBefore);
    check("quietSeconds", fifth, { quiet });
    const beforeDeep = requests.length;
    await pop(25);
    await rowBecomes({ tx_confirmations: 0, tx_block_height: null }, fifth);
    await mine(27);
    await assertMined(signedFifth.tx_hash, fifthBlock, 27);
    await rowBecomes({ tx_confirmations: 27, tx_block_height: fifthBlock, paid_status: 0 }, fifth);
    expect(names(beforeDeep)).toContain("get_info");
    check("deepReorg", fifth);
    await mine(13);
    await rowBecomes({ tx_confirmations: 40, paid_status: 1 }, fifth);
    check("deepReorgPaid", fifth);

    // 12. the same handover is safe. a confirmed tracker does not broadcast again.
    expect(await handover()).toMatchObject({ ok: true, tx_hash: signed.tx_hash });
    expect(row()).toMatchObject({ paid_status: 1, tx_confirmations: 3 });
    expect((database.query("SELECT count(*) AS count FROM checkout_session").get() as any).count).toBe(5);
    check("repeatedHandover");
    // every checkout is paid. the tracker is idle and the final states remain saved.
    const finalStates = (database.query("SELECT tracker_state FROM checkout_session").all() as { tracker_state: string }[]).map((entry) => JSON.parse(entry.tracker_state));
    expect(finalStates).toHaveLength(5);
    expect(finalStates.every((state) => state.state === "confirmed")).toBe(true);
    const finalRequestCount = requests.length;
    await Bun.sleep(1500);
    expect(requests).toHaveLength(finalRequestCount);
    checks.savedStateAtTheEnd = finalStates;
    checks.serverFiles = await readdir(`${directory}/server`);
    expect((checks.serverFiles as string[]).every((name) => name.startsWith("checkout.sqlite"))).toBe(true);
    // the server asked the node for nothing else. no request named a transaction hash.
    const count: Record<string, number> = {};
    for (const name of names()) count[name] = (count[name] ?? 0) + 1;
    expect(Object.keys(count).sort()).toEqual(["/send_raw_transaction", "get_block", "get_info"]);
    expect(count["/send_raw_transaction"]).toBe(5);
    const walletLog = await Bun.file(`${directory}/wallet-stdout.log`).text();
    expect(walletLog).not.toContain("Failed to initialize ringdb");
    expect(walletLog).not.toContain("Failed to set rings");
    await Bun.write(`${directory}/results.json`, JSON.stringify({ checks, nodeCalls: count }, null, 2));
    database.close();
  } catch (error) {
    await Bun.write(`${directory}/failure.json`, JSON.stringify({ error: String(error), checks, requests }, null, 2));
    throw error;
  } finally {
    releaseSubmission();
    for (const child of children.reverse()) if (child !== monerod) await stop(child);
    if (monerod) await stopNode(monerod);
    proxy.stop(true);
  }
}, { timeout: 270000 });
