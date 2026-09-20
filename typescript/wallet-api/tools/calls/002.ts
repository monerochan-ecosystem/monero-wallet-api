import type { ToolWorkerContext } from "../../actionlog/actionLogTypes";
import {
  getExtensionRuntime,
  sendToBackground,
  sendToPort,
  TOOL_MAGIC_STRING,
  type PortMessageByKind,
  type PortMessageKind,
  type ToolArm,
  type ToolInvocationForValidate,
  type ToolInvocationValidity,
} from "../globals";

import type { ParsedMoneroToolInvocation } from "../monero-tools";

export type CreateAndShareViewOnlyWalletTool = {
  tool_id: "002";
  payload: CreateAndShareViewOnlyWalletToolPayload;
};
export type CreateAndShareViewOnlyWalletToolPayload = {
  wallet_slot: number;
};

function recognize_parse(
  args: string[],
): CreateAndShareViewOnlyWalletTool | null {
  const wallet_slot = args[5];
  if (wallet_slot && !isNaN(parseInt(wallet_slot))) {
    return {
      tool_id: "002",
      payload: { wallet_slot: parseInt(wallet_slot) },
    };
  }
  return null;
}

function make(payload: CreateAndShareViewOnlyWalletToolPayload): string {
  const wallet_slot = Number(payload.wallet_slot) || 0;
  return `${TOOL_MAGIC_STRING}002_create_and_share_viewkey_slot_${wallet_slot}`;
}

/** valid if both domains are the same. */
function validate_check(
  invo: ToolInvocationForValidate,
): ToolInvocationValidity {
  if (invo.tool.tool_id !== "002") return "unverified";
  if (invo.context_domain == invo.destination_domain) return "valid";
  return "invalid";
}

export type ShareViewkeyPayload = PortMessageByKind["shareViewkey"];
export type ShareViewkeyResult = {
  ok: boolean;
  successUrl: string | null;
  error?: string;
};

export type ShareViewkey002Pruned = {
  viewkey: string;
  primary_address: string;
  wallet_slot: number;
};

/** posts the viewkey. the invocation must be valid. */
async function shareViewKey002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult> {
  const invo = payload.tool_invo;
  if (invo.tool.tool_id !== "002")
    return { ok: false, successUrl: null, error: "not 002" };
  if (invo.valid !== "valid")
    return { ok: false, successUrl: null, error: "invocation not valid" };
  const link = invo[invo.found_in];
  const invo_link = new URL(link);
  const shareVKUrl = `${invo_link.origin}/monerochan002/`;
  try {
    const result = await fetch(shareVKUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewkey: payload.viewkey,
        primary_address: payload.primary_address,
        wallet_slot: invo.tool.payload.wallet_slot,
      }),
    });
    if (result.ok) {
      const data = (await result.json()) as ShareViewkeyResult;
      if (!data || typeof data !== "object" || data.ok !== true) {
        return {
          ok: false,
          successUrl: null,
          error: "counterparty rejected share",
        };
      }
      const successUrl =
        typeof data.successUrl === "string" && data.successUrl.length
          ? data.successUrl
          : null;
      return { ok: true, successUrl };
    }
    return {
      ok: false,
      successUrl: null,
      error: `share post failed ${result.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      successUrl: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function potentialSuccessRedirect002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult | undefined> {
  const shareVKresult = await shareViewKey002(payload);
  if (shareVKresult.ok) {
    if (shareVKresult.successUrl) {
      window.location.href = shareVKresult.successUrl;
      window.location.reload();
    }
    return;
  }
  return shareVKresult;
}

function execute_deliver(invo: ToolInvocationForValidate) {
  const rt = getExtensionRuntime();
  if (!rt) return;
  const port = rt.connect({ name: invo.invocation_id });
  port.onMessage.addListener((msg: unknown) => {
    const m = msg as {
      kind?: PortMessageKind;
      payload?: PortMessageByKind["shareViewkey"];
    };
    if (m.kind !== "shareViewkey" || !m.payload) return;
    const payload = m.payload;
    void (async () => {
      try {
        const result = await potentialSuccessRedirect002(payload);
        if (result) {
          void sendToBackground("shareViewkeyFAILED", {
            ...payload,
            error: result.error,
          }).catch(() => {});
        } else {
          void sendToBackground("shareViewkeyOK", {
            invocationId: invo.invocation_id,
          }).catch(() => {});
        }
      } catch (e) {
        void sendToBackground("shareViewkeyFAILED", {
          ...payload,
          error: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
      }
    })();
  });
}

async function handle002ShareRequest(
  req: Request,
  wallets: { wallet_slot?: number; primary_address: string }[],
  parsed_cb: (parsed_body: ShareViewkey002Pruned) => Promise<void>,
  successUrl?: string,
): Promise<ShareViewkeyResult> {
  try {
    const json_body = await req.json();
    const { viewkey, primary_address, wallet_slot } =
      json_body as ShareViewkey002Pruned;

    if (
      typeof viewkey !== "string" ||
      viewkey.trim().length === 0 ||
      typeof primary_address !== "string" ||
      primary_address.trim().length === 0 ||
      typeof wallet_slot !== "number"
    ) {
      return { ok: false, successUrl: null };
    }
    const foundSlot = wallets.find(
      (wallet) => wallet.wallet_slot === wallet_slot,
    );
    if (foundSlot) {
      if (foundSlot.primary_address !== primary_address) {
        return { ok: false, successUrl: null };
      }
    }
    await parsed_cb({ viewkey, primary_address, wallet_slot });
    return {
      ok: true,
      successUrl: successUrl ?? null,
    };
  } catch {
    return { ok: false, successUrl: null };
  }
}

/** mco surface used to save view wallet on share success */
export type ShareViewMco = {
  wallets: {
    primary_address: string;
    wallet_slot?: number;
    wallet_name?: string;
  }[];
  addViewWallet: (
    primary_address: string,
    view_key: string,
    fields?: {
      wallet_name?: string;
      wallet_slot?: number;
    },
  ) => Promise<void>;
  setWalletName: (primary_address: string, name?: string) => Promise<void>;
  setWalletSlot: (primary_address: string, slot?: number) => Promise<void>;
};

export type HandleShareOpts = {
  successUrl?: string;
};

async function handleShare(
  req: Request,
  mco: ShareViewMco,
  opts?: HandleShareOpts,
): Promise<Response> {
  const res = await handle002ShareRequest(
    req,
    mco.wallets,
    async ({ primary_address, viewkey, wallet_slot }) => {
      const pa = primary_address.trim();
      const vk = viewkey.trim();
      const existing = mco.wallets.find((w) => w.primary_address === pa);
      const wallet_name =
        existing?.wallet_name ?? "unnamed wallet " + wallet_slot;
      if (existing) {
        await mco.setWalletName(pa, wallet_name);
        await mco.setWalletSlot(pa, wallet_slot);
      } else {
        await mco.addViewWallet(pa, vk, { wallet_name, wallet_slot });
      }
    },
    opts?.successUrl,
  );
  return Response.json(res);
}

function execute_route(
  mco: ShareViewMco,
  opts?: HandleShareOpts,
): (req: Request) => Promise<Response> {
  return (req) => handleShare(req, mco, opts);
}

export type FailedShareViewRestore = {
  viewkey: string;
  primary_address: string;
  error?: string;
  tool_invo: {
    invocation_id: string;
    context_domain: string;
    context_href: string;
    destination_domain: string;
    found_in: "link" | "linkText";
    link: string;
    linkText: string;
    timestamp: number;
    valid: "valid" | "invalid" | "unverified";
    tool: { tool_id: string; payload: { wallet_slot?: number } };
  };
};

function flatFromParsed(invo: ParsedMoneroToolInvocation) {
  const p = invo.tool.payload as CreateAndShareViewOnlyWalletToolPayload;
  return {
    invocationId: invo.invocation_id,
    toolId: "002" as const,
    wallet_slot: p.wallet_slot,
    context_domain: invo.context_domain,
    destination_domain: invo.destination_domain,
    context_href: invo.context_href,
    found_in: invo.found_in,
    link: invo.link,
    linkText: invo.linkText,
  };
}

/** first toolCall state transition: session_start invoked. */
async function invoke_write(ctx: ToolWorkerContext, invo: ToolInvocationForValidate) {
  if (invo.tool.tool_id !== "002") return;
  const flat = flatFromParsed(invo as ParsedMoneroToolInvocation);
  await ctx.log.append({
    type: "session_start",
    stage: "invoked",
    ...flat,
  });
}

/** second toolCall state transition: validate_result validated. */
async function validate_write(
  ctx: ToolWorkerContext,
  invo: ToolInvocationForValidate,
) {
  if (invo.tool.tool_id !== "002") return;
  const flat = flatFromParsed(invo as ParsedMoneroToolInvocation);
  await ctx.log.append({
    type: "validate_result",
    stage: "validated",
    ...flat,
    valid: invo.valid,
  });
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

function isTerminalTipType(type: string): boolean {
  return type === "dismiss" || type === "execute_result" || type === "aborted";
}

/** the content payload from this invocation. missing valid is unverified. */
function invoFromOpen(
  invocationId: string,
  open: {
    wallet_slot?: number;
    destination_domain?: string;
    context_domain?: string;
    found_in?: "link" | "linkText";
    link?: string;
    linkText?: string;
    context_href?: string;
    valid?: ToolInvocationValidity;
  },
): ParsedMoneroToolInvocation {
  return {
    tool: {
      tool_id: "002",
      payload: { wallet_slot: open.wallet_slot ?? 0 },
    },
    destination_domain: open.destination_domain ?? "",
    context_domain: open.context_domain ?? "",
    found_in: open.found_in ?? "link",
    link: open.link ?? "",
    linkText: open.linkText ?? "",
    timestamp: Date.now(),
    invocation_id: invocationId,
    context_href: open.context_href ?? "",
    valid: open.valid ?? "unverified",
  };
}

/** third toolCall state transition: accept accepted. */
async function accept_yes(
  ctx: ToolWorkerContext,
  invocationId: string,
  _args: Record<string, unknown>,
) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo || alreadyAccepted(invo.lastType)) return;
  const open =
    ctx.log.invocations("active").find(
      (o) => o.invocationId === invocationId,
    ) ?? null;
  if (!open) return;
  await ctx.log.append({
    type: "accept",
    stage: "accepted",
    ...flatFromParsed(invoFromOpen(invocationId, open)),
  });
}

/** fourth toolCall state transition: execute_start executed. execute_error executed if no port. */
async function execute_run(
  ctx: ToolWorkerContext,
  invocationId: string,
  args: Record<string, unknown>,
) {
  const open =
    ctx.log.invocations("active").find(
      (o) => o.invocationId === invocationId,
    ) ?? null;
  if (!open) return;
  const tool_invo = invoFromOpen(invocationId, open);
  const flat = flatFromParsed(tool_invo);
  const port = ctx.getPort(invocationId);
  if (!port) {
    await ctx.log.append({
      type: "execute_error",
      stage: "executed",
      ...flat,
      ok: false,
      error: "no content script port",
    });
    return;
  }
  sendToPort(port, "shareViewkey", {
    viewkey: String(args.viewkey ?? ""),
    primary_address: String(args.primary_address ?? ""),
    tool_invo,
  } as PortMessageByKind["shareViewkey"]);
  await ctx.log.append({
    type: "execute_start",
    stage: "executed",
    ...flat,
  });
}

/** fifth toolCall state transition: execute_error executed. */
async function execute_fail(
  ctx: ToolWorkerContext,
  payload: unknown,
) {
  const p = payload as FailedShareViewRestore;
  await ctx.log.append({
    type: "execute_error",
    stage: "executed",
    ...flatFromParsed(p.tool_invo as ParsedMoneroToolInvocation),
    ok: false,
    error: p.error ?? "share failed",
  });
}

/** fifth toolCall state transition: execute_result executed. */
async function execute_ok(
  ctx: ToolWorkerContext,
  payload: { invocationId: string },
) {
  const invo = await ctx.log.invocation(payload.invocationId);
  if (!invo) return;
  await ctx.log.append({
    type: "execute_result",
    stage: "executed",
    invocationId: payload.invocationId,
    toolId: "002",
    ok: true,
  });
}

/** toolCall state transition: dismiss accepted. */
async function accept_no(ctx: ToolWorkerContext, invocationId: string) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo || isTerminalTipType(invo.lastType)) return;
  await ctx.log.append({
    type: "dismiss",
    stage: "accepted",
    invocationId,
    toolId: "002",
  });
}

/** toolCall state transition: aborted. */
async function execute_abort(
  ctx: ToolWorkerContext,
  invocationId: string,
) {
  const invo = await ctx.log.invocation(invocationId);
  if (!invo || isTerminalTipType(invo.lastType)) return;
  await ctx.log.append({
    type: "aborted",
    stage: invo.stage,
    invocationId,
    toolId: "002",
  });
}

type Tool002CounterpartyExtra = {
  execute_route: typeof execute_route;
};

const tool002: ToolArm<
  CreateAndShareViewOnlyWalletToolPayload,
  Tool002CounterpartyExtra
> = {
  permissions: ["share_view"] as const,
  ui: {
    openTitle: "view-only wallet share",
    acceptLabel: "ACCEPT",
    dismissLabel: "DISMISS",
  },
  content: {
    recognize_parse,
    validate_check,
    execute_deliver,
  },
  worker: {
    invoke_write,
    validate_write,
    accept_yes,
    accept_no,
    execute_run,
    execute_abort,
    execute_ok,
    execute_fail,
  },
  counterparty: {
    make,
    execute_route,
  },
};

export default tool002;
