import {
  convertAmountBigInt,
  convertAmountBigIntThrows,
} from "../../send-functionality/conversion";
import type { InvocationState, ToolWorkerContext } from "../../actionlog/actionLogTypes";
import type { ScanCacheOpened } from "../../scanning-syncing/scanresult/scanCacheOpened";
import {
  TOOL_MAGIC_STRING,
  getExtensionRuntime,
  sendToBackground,
  sendToPort,
  type ExtensionBrowser,
  type ExtensionPort,
  type ToolArm,
  type ToolInvocationForValidate,
  type ToolInvocationValidity,
} from "../globals";
import type { ParsedMoneroToolInvocation } from "../monero-tools";

export type SendTransactionTool = {
  tool_id: "001";
  payload: SendTransactionToolPayload;
};
export type SendTransactionToolPayload = {
  address: string;
  amount: string;
  no_check: boolean;
  successUrl?: string;
  handoverUrl?: string;
};

function recognize_parse(
  args: string[],
): SendTransactionTool | null {
  const amount = args[1];
  const address = args[3];
  // trailing _no_check splits into ["no", "check"] after underscore split
  const no_check =
    args.length >= 6 &&
    args[args.length - 2] === "no" &&
    args[args.length - 1] === "check";
  try {
    convertAmountBigIntThrows(amount);
  } catch {
    return null;
  }
  if (address && amount) {
    return {
      tool_id: "001",
      payload: { address, amount, no_check },
    };
  }
  return null;
}

function make(payload: SendTransactionToolPayload): string {
  convertAmountBigIntThrows(payload.amount);
  const base = `${TOOL_MAGIC_STRING}001_amount_${payload.amount}_address_${payload.address}`;
  return payload.no_check ? `${base}_no_check` : base;
}

// base58, 95 chars for a standard address and 106 for an integrated one.
const MONERO_ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/;
const VALIDATION_TIMEOUT_MS = 15_000;

async function validate_check(
  invo: ToolInvocationForValidate,
): Promise<ToolInvocationValidity> {
  const tool = invo.tool as SendTransactionTool;
  if (tool.tool_id !== "001") return "unverified";
  if (tool.payload.no_check) return "unverified";
  // the address goes into the path. a real address is base58 and 95 or 106 chars.
  // anything else could rewrite the request path, so it never reaches the fetch.
  if (!MONERO_ADDRESS_SHAPE.test(tool.payload.address)) return "invalid";
  const link = invo[invo.found_in];
  const invo_link = new URL(link);
  const checkUrl = `${invo_link.origin}/monerochan001/${tool.payload.address}`;
  try {
    // no redirects: a shop must not bounce the request to another host.
    const result = (await (
      await fetch(checkUrl, { redirect: "error", signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) })
    ).json()) as unknown;
    if (
      result &&
      typeof result === "object" &&
      "valid_address" in result &&
      result.valid_address === true
    ) {
      const data = result as { successUrl?: unknown; handoverUrl?: unknown };
      const urls: { successUrl?: string; handoverUrl?: string } = {};
      for (const key of ["successUrl", "handoverUrl"] as const) {
        if (data[key] === undefined) continue;
        if (typeof data[key] !== "string" || !data[key]) return "invalid";
        const url = new URL(data[key], invo_link.origin);
        if (url.origin !== invo_link.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return "invalid";
        urls[key] = url.href;
      }
      if (!!urls.successUrl !== !!urls.handoverUrl) return "invalid";
      Object.assign(tool.payload, urls);
      return "valid";
    }
    return "invalid";
  } catch {
    return "invalid";
  }
}

const ADDRESS_VALID_RESPONSE = {
  valid_address: true,
} as const;

const ADDRESS_INVALID_RESPONSE = {
  valid_address: false,
} as const;

export type IsPayAddressKnown = (
  address: string,
) => boolean | Promise<boolean>;

function addressFromMonerochan001Req(req: Request): string {
  const r = req as Request & { params?: { address?: string } };
  if (r.params?.address) return decodeURIComponent(r.params.address);
  const m = new URL(req.url).pathname.match(/monerochan001\/([^/]+)\/?$/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

async function handleAddressCheck(
  req: Request,
  deps: { isPayAddressKnown: IsPayAddressKnown; getUrls?: (address: string, req: Request) => { successUrl?: string; handoverUrl?: string } | Promise<{ successUrl?: string; handoverUrl?: string }> },
): Promise<Response> {
  const address = addressFromMonerochan001Req(req);
  if (!address) return Response.json(ADDRESS_INVALID_RESPONSE);
  const known = await deps.isPayAddressKnown(address);
  if (!known) return Response.json(ADDRESS_INVALID_RESPONSE);
  return Response.json({ ...ADDRESS_VALID_RESPONSE, ...await deps.getUrls?.(address, req) });
}

function validate_route(deps: {
  isPayAddressKnown: IsPayAddressKnown;
  getUrls?: (address: string, req: Request) => { successUrl?: string; handoverUrl?: string } | Promise<{ successUrl?: string; handoverUrl?: string }>;
}): (req: Request) => Promise<Response> {
  return (req) => handleAddressCheck(req, deps);
}

function flatFromParsed(invo: ParsedMoneroToolInvocation) {
  const p = invo.tool.payload as SendTransactionToolPayload;
  return {
    invocationId: invo.invocation_id,
    toolId: "001" as const,
    amount: p.amount,
    address: p.address,
    no_check: p.no_check,
    context_domain: invo.context_domain,
    destination_domain: invo.destination_domain,
    context_href: invo.context_href,
    found_in: invo.found_in,
    link: invo.link,
    linkText: invo.linkText,
    ...(p.successUrl ? { successUrl: p.successUrl } : {}),
    ...(p.handoverUrl ? { handoverUrl: p.handoverUrl } : {}),
  };
}

/** first toolCall state transition: session_start invoked. */
async function invoke_write(ctx: ToolWorkerContext, invo: ToolInvocationForValidate) {
  if (invo.tool.tool_id !== "001") return;
  const flat = flatFromParsed(invo as ParsedMoneroToolInvocation);
  await ctx.log.append({
    type: "session_start",
    stage: "invoked",
    ...flat,
  });
}

const validationWaiters = new Map<string, () => void>();

/** second toolCall state transition: validate_result validated. */
async function validate_write(
  ctx: ToolWorkerContext,
  invo: ToolInvocationForValidate,
) {
  if (invo.tool.tool_id !== "001") return;
  const flat = flatFromParsed(invo as ParsedMoneroToolInvocation);
  await ctx.log.append({
    type: "validate_result",
    stage: "validated",
    ...flat,
    valid: invo.valid,
  });
  validationWaiters.get(invo.invocation_id)?.();
}

async function waitForValidation(ctx: ToolWorkerContext, invocationId: string) {
  const ready = Promise.withResolvers<void>();
  validationWaiters.set(invocationId, ready.resolve);
  const timer = setTimeout(ready.resolve, VALIDATION_TIMEOUT_MS);
  try {
    // re-read after registering in case validation has already been saved.
    const current = (await ctx.log.invocation(invocationId))?.valid;
    if (current === "valid" || current === "invalid") return current;
    await ready.promise;
    return (await ctx.log.invocation(invocationId))?.valid;
  } finally {
    clearTimeout(timer);
    validationWaiters.delete(invocationId);
  }
}

export function amountForChainSend(amount: string): string {
  return convertAmountBigInt(amount).toString();
}

function alreadyAccepted(type: string): boolean {
  return (
    type === "accept" ||
    type === "execute_start" ||
    type === "execute_error" ||
    type === "execute_result" ||
    type === "dismiss" ||
    type === "aborted"
  );
}

/** third toolCall state transition: accept accepted. */
async function accept_yes(
  ctx: ToolWorkerContext,
  invocationId: string,
  args: Record<string, unknown>,
) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo || alreadyAccepted(invo.lastType)) return;
  const address = String(args.address ?? invo.address ?? "");
  const amount = String(args.amount ?? invo.amount ?? "");
  const wallet_to_send_from_pa = String(args.wallet_to_send_from_pa ?? "");
  await ctx.log.append({
    type: "accept",
    stage: "accepted",
    invocationId,
    toolId: "001",
    address,
    amount,
    wallet_to_send_from_pa,
  });
}

const executing = new Set<string>();

/** fourth toolCall state transition: execute_start executed. fifth: execute_result executed. */
async function execute_run(ctx: ToolWorkerContext, invocationId: string, args: Record<string, unknown>) {
  if (executing.has(invocationId)) return;
  executing.add(invocationId);
  try {
    if (args.retryHandover === true) return await retry_handover(ctx, invocationId);
    return await execute_send(ctx, invocationId, args);
  } finally { executing.delete(invocationId); }
}

async function execute_send(ctx: ToolWorkerContext, invocationId: string, args: Record<string, unknown>) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo) {
    console.error("send with no invocation");
    return;
  }
  if (invo.events.some((event) => event.type === "execute_start")) return;
  const address = String(args.address ?? invo.address ?? "");
  const amount = String(args.amount ?? invo.amount ?? "");
  const wallet_to_send_from_pa = String(
    args.wallet_to_send_from_pa ?? invo.wallet_to_send_from_pa ?? "",
  );
  const validity = !invo.no_check && (invo.valid === undefined || invo.valid === "unverified")
    ? await waitForValidation(ctx, invocationId)
    : invo.valid;
  const toolId = "001" as const;
  await ctx.log.append({
    type: "execute_start",
    stage: "executed",
    invocationId,
    toolId,
    address,
    amount,
    wallet_to_send_from_pa,
  });

  let sentByUs = false;
  let error: string | undefined;
  let handover: Promise<HandoverResult | null> | undefined;
  try {
    if (validity === "invalid") throw new Error("merchant address validation failed");
    if (!invo.no_check && validity !== "valid") throw new Error("merchant address validation timed out");
    const fee_priority = args.fee_priority;
    if (
      fee_priority !== undefined && fee_priority !== "unimportant" &&
      fee_priority !== "normal" && fee_priority !== "elevated" && fee_priority !== "priority"
    ) {
      throw new Error("invalid fee priority");
    }
    const fee_circuit_breaker = args.fee_circuit_breaker;
    if (fee_circuit_breaker !== undefined && typeof fee_circuit_breaker !== "number") {
      throw new Error("invalid fee circuit breaker");
    }
    const wallets = ctx.getWallets?.() as { wallets?: ScanCacheOpened[] } | undefined;
    const wallet = wallets?.wallets?.find(
      (w) => w.primary_address === wallet_to_send_from_pa,
    );
    if (!wallet) throw new Error("wallet not found");
    const signed = await wallet.makeSignTransaction({
      payments: [{ address, amount: amountForChainSend(amount) }],
      fee_priority,
      fee_circuit_breaker,
      invocationId,
    });
    // the signed bytes can leave only after the coordinator has saved the lock.
    const result = await wallet.sendSignedTransaction(signed, invocationId, () => {
      handover = deliverSignedTransaction(ctx, invocationId, wallet, signed.txLogIndex, signed.signedTx);
    });
    sentByUs = true;
    error = result.cache_error;
  } catch (e) {
    console.error(e);
    error = e instanceof Error ? e.message : String(e);
  }
  // null: the merchant gave no handover url
  const delivered = handover ? await handover : null;

  await ctx.log.append({
    type: "execute_result",
    stage: "executed",
    invocationId,
    toolId,
    // with a handover url the call is done when the merchant has the transaction. its node sends it too.
    ok: delivered ? delivered.ok : sentByUs,
    // a node took the transaction: ours, or the one of the merchant.
    // not ok and sent is "paid, but the merchant did not get it". only that state can retry the handover.
    sent: sentByUs || delivered?.ok === true,
    ...(error ? { error } : {}),
    ...(handover ? { handover: delivered } : {}),
    address,
    amount,
    wallet_to_send_from_pa,
  });
}

/** toolCall state transition: dismiss accepted. */
async function accept_no(ctx: ToolWorkerContext, invocationId: string) {
  const invo = await ctx.log.invocation(invocationId);
  // once the user accepted, execution is in flight. a late dismiss (the send
  // plate clears the form right after execute) must not flip the entry to dismissed
  if (
    !invo ||
    invo.lastType === "dismiss" ||
    invo.lastType === "accept" ||
    invo.lastType === "execute_start" ||
    invo.lastType === "execute_result" ||
    invo.lastType === "aborted"
  ) {
    return;
  }
  await ctx.log.append({
    type: "dismiss",
    stage: "accepted",
    invocationId,
    toolId: "001",
  });
}

type Delivery = { handoverUrl: string; tx_as_hex: string };

function browserTabs() {
  const g = globalThis as unknown as { browser?: ExtensionBrowser; chrome?: ExtensionBrowser };
  return g.browser?.tabs ?? g.chrome?.tabs;
}

async function createTab(url: string): Promise<number> {
  const tabs = browserTabs();
  const result = (tabs?.create ? await tabs.create({ url }) : await sendToBackground("tabs.create", { url })) as { id?: number; error?: string };
  if (result?.error) throw new Error(result.error);
  if (typeof result?.id !== "number") throw new Error("could not open merchant page");
  return result.id;
}

function sameMerchantPage(actual: string | undefined, expected: URL): boolean {
  if (!actual) return false;
  try {
    const url = new URL(actual);
    return url.origin === expected.origin && url.pathname === expected.pathname && url.search === expected.search;
  } catch { return false; }
}

type HandoverResult = { ok: boolean; error?: string; tx_hash?: string };

/** hands the saved signed transaction over again after a failed send or handover. */
async function retry_handover(ctx: ToolWorkerContext, invocationId: string) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo || invo.lastType !== "execute_result" || !handoverUrls(invo)) return;
  const last = invo.events.findLast((event) => event.type === "execute_result");
  if (last?.ok !== false) return;
  const wallets = ctx.getWallets?.() as { wallets?: ScanCacheOpened[] } | undefined;
  const wallet = wallets?.wallets?.find((row) => row.primary_address === invo.wallet_to_send_from_pa);
  const index = wallet?.tx_logs.findIndex((row) => row.invocationId === invocationId) ?? -1;
  const signed = wallet?.tx_logs[index]?.signed_tx;
  if (!wallet || !signed) return;
  let handover: HandoverResult | null;
  try {
    await wallet.renewTransactionLock(index);
    handover = await deliverSignedTransaction(ctx, invocationId, wallet, index, signed);
  } catch (error) {
    handover = { ok: false, error: String(error) };
  }
  if (!handover) return;
  await ctx.log.append({
    type: "execute_result",
    stage: "executed",
    invocationId,
    toolId: "001",
    ok: handover.ok,
    sent: last.sent === true || wallet.tx_logs[index]?.broadcast_accepted === true || handover.ok,
    handover,
  });
}

async function deliverSignedTransaction(ctx: ToolWorkerContext, invocationId: string, wallet: ScanCacheOpened, index: number, signed: string) {
  const result = await handover_transaction(ctx, invocationId, signed);
  if (!result?.ok) return result;
  try {
    await wallet.recordHandoverAcceptance(index);
    return result;
  } catch (error) {
    return { ...result, error: String(error) };
  }
}

function pageOrigin(url?: string): string | null {
  try { return new URL(String(url)).origin; } catch { return null; }
}

// a disconnected source port means the page is gone. only that case opens a replacement tab.
function postHandover(port: ExtensionPort, delivery: Delivery): Promise<HandoverResult | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: HandoverResult | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onMessage.removeListener?.(receive);
      port.onDisconnect.removeListener?.(disconnected);
      if (error) reject(error);
      else resolve(result);
    };
    const receive = (message: unknown) => {
      if (message && typeof message === "object" && "ok" in message && typeof message.ok === "boolean") finish(message as HandoverResult);
    };
    const disconnected = () => finish(null);
    const timer = setTimeout(() => finish(null, new Error("merchant handover timed out")), 15000);
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnected);
    try { sendToPort(port, "handover", delivery); }
    catch { finish(null); }
  });
}

function handoverUrls(invo: InvocationState) {
  if (invo.toolId !== "001" || invo.valid !== "valid") return;
  const validation = invo.events.findLast((event) => event.type === "validate_result");
  const execution = invo.events.find((event) => event.type === "execute_start");
  if (!execution || validation?.address !== execution.address) return;
  const successUrl = validation?.successUrl;
  const handoverUrl = validation?.handoverUrl;
  if (typeof successUrl === "string" && typeof handoverUrl === "string") return { successUrl, handoverUrl };
}

/** posts the signed transaction from the merchant page that made the call, or from a new tab. */
async function handover_transaction(ctx: ToolWorkerContext, invocationId: string, tx_as_hex: string): Promise<HandoverResult | null> {
  const invo = await ctx.log.invocation(invocationId);
  const urls = invo && handoverUrls(invo);
  if (!urls) return null;
  const { successUrl, handoverUrl } = urls;
  try {
    const page = new URL(successUrl);
    const source = new URL(invo.context_href || successUrl);
    const port = ctx.getPort(invocationId);
    const sender = port?.sender;
    const usable = typeof sender?.tab?.id === "number" && sender.frameId === 0 &&
      pageOrigin(sender.url) === pageOrigin(handoverUrl) &&
      (sameMerchantPage(sender.url, source) || sameMerchantPage(sender.url, page));
    const delivery = { handoverUrl, tx_as_hex };
    let response = port && usable ? await postHandover(port, delivery) : null;
    if (!response) {
      page.hash += `${page.hash ? "&" : ""}monerochan_handover=${invocationId}`;
      const tabId = await createTab(page.href);
      let replacement: ExtensionPort | undefined;
      for (let tries = 0; tries < 100 && !replacement; tries++) {
        const candidate = ctx.getPort(invocationId);
        if (candidate?.sender?.tab?.id === tabId && candidate.sender.frameId === 0 && sameMerchantPage(candidate.sender.url, page)) replacement = candidate;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!replacement) throw new Error("merchant page did not connect");
      response = await postHandover(replacement, delivery);
    }
    if (response?.ok !== true) return { ok: false, error: response?.error || "merchant handover failed", tx_hash: response?.tx_hash };
    return { ok: true, tx_hash: response.tx_hash };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function attachHandover(port: ExtensionPort) {
  port.onMessage.addListener((message) => {
    const m = message as { kind?: string; payload?: Partial<Delivery> };
    if (m.kind !== "handover" || !m.payload) return;
    const { handoverUrl, tx_as_hex } = m.payload;
    void (async () => {
      if (!handoverUrl || !tx_as_hex) throw new Error("invalid handover");
      const endpoint = new URL(handoverUrl);
      // our own origin only. the payer wallet proves which page this is.
      if (endpoint.origin !== location.origin) throw new Error("wrong handover origin");
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        redirect: "error", signal: AbortSignal.timeout(15000), body: JSON.stringify({ tx_as_hex }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; tx_hash?: string };
      return { ok: response.ok && body.ok === true, error: body.error || (response.ok ? undefined : `merchant returned ${response.status}`), tx_hash: body.tx_hash };
    })().then(
      (result) => port.postMessage(result),
      (error) => port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

/** the page that made the call keeps its port open for the handover. */
function execute_deliver(invo: ToolInvocationForValidate) {
  const payload = invo.tool.payload as SendTransactionToolPayload;
  if (invo.valid !== "valid" || !payload.handoverUrl || (typeof window !== "undefined" && window.top !== window)) return;
  const rt = getExtensionRuntime();
  if (!rt?.connect) return;
  attachHandover(rt.connect({ name: invo.invocation_id }));
}

/** a merchant page opened for this handover. */
function installDelivery() {
  const rt = getExtensionRuntime();
  if (!rt || typeof window === "undefined" || window.top !== window) return;
  const invocationId = location.hash.match(/(?:^#|&)monerochan_handover=([a-f0-9-]+)(?:&|$)/)?.[1];
  if (!invocationId) return;
  attachHandover(rt.connect({ name: invocationId }));
}


type Tool001CounterpartyExtra = {
  validate_route: typeof validate_route;
};

const tool001: ToolArm<SendTransactionToolPayload, Tool001CounterpartyExtra> = {
  permissions: ["spend"] as const,
  ui: {
    openTitle: "payment link",
    acceptLabel: "SEND",
    dismissLabel: "DISMISS",
  },
  content: {
    recognize_parse,
    validate_check,
    execute_deliver,
    install: installDelivery,
  },
  worker: {
    // a late address check cannot reopen a payment once execution starts.
    should_apply_event: (current, event) =>
      event.type !== "validate_result" ||
      !current.events.some((entry) => entry.type === "execute_start"),
    invoke_write,
    validate_write,
    accept_yes,
    accept_no,
    execute_run,
  },
  counterparty: {
    make,
    validate_route,
  },
};

export default tool001;
