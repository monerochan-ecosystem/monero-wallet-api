import {
  convertAmountBigInt,
  convertAmountBigIntThrows,
} from "../../send-functionality/conversion";
import type { ToolWorkerContext } from "../../actionlog/actionLogTypes";
import {
  TOOL_MAGIC_STRING,
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

async function validate_check(
  invo: ToolInvocationForValidate,
): Promise<ToolInvocationValidity> {
  const tool = invo.tool as SendTransactionTool;
  if (tool.tool_id !== "001") return "unverified";
  if (tool.payload.no_check) return "unverified";
  const link = invo[invo.found_in];
  const invo_link = new URL(link);
  const checkUrl = `${invo_link.origin}/monerochan001/${tool.payload.address}`;
  try {
    const result = (await (await fetch(checkUrl)).json()) as unknown;
    if (
      result &&
      typeof result === "object" &&
      "valid_address" in result &&
      result.valid_address === true
    ) {
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
  deps: { isPayAddressKnown: IsPayAddressKnown },
): Promise<Response> {
  const address = addressFromMonerochan001Req(req);
  if (!address) return Response.json(ADDRESS_INVALID_RESPONSE);
  const known = await deps.isPayAddressKnown(address);
  return Response.json(
    known ? ADDRESS_VALID_RESPONSE : ADDRESS_INVALID_RESPONSE,
  );
}

function validate_route(deps: {
  isPayAddressKnown: IsPayAddressKnown;
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
  };
}

async function invoke_write(ctx: ToolWorkerContext, invo: ToolInvocationForValidate) {
  if (invo.tool.tool_id !== "001") return;
  const flat = flatFromParsed(invo as ParsedMoneroToolInvocation);
  await ctx.log.append({
    type: "session_start",
    stage: "invoked",
    ...flat,
  });
}

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

async function accept_yes(
  ctx: ToolWorkerContext,
  invocationId: string,
  args: Record<string, unknown>,
) {
  const tip = await ctx.log.getTip(invocationId);
  if (!tip || alreadyAccepted(tip.type)) return;
  const address = String(args.address ?? tip.address ?? "");
  const amount = String(args.amount ?? tip.amount ?? "");
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

async function execute_run(
  ctx: ToolWorkerContext,
  invocationId: string,
  args: Record<string, unknown>,
) {
  const tip = await ctx.log.getTip(invocationId);
  if (!tip) {
    console.error("send with no tip for invocation");
    return;
  }
  const address = String(args.address ?? tip.address ?? "");
  const amount = String(args.amount ?? tip.amount ?? "");
  const wallet_to_send_from_pa = String(
    args.wallet_to_send_from_pa ?? tip.wallet_to_send_from_pa ?? "",
  );
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

  let ok = false;
  try {
    const wallets = ctx.getWallets?.() as
      | {
          wallets?: {
            primary_address: string;
            makeSignSendTransaction: (p: {
              payments: { address: string; amount: string }[];
              invocationId?: string;
            }) => Promise<unknown>;
          }[];
        }
      | undefined;
    const wallet = wallets?.wallets?.find(
      (w) => w.primary_address === wallet_to_send_from_pa,
    );
    if (!wallet) throw new Error("wallet not found");
    await wallet.makeSignSendTransaction({
      payments: [{ address, amount: amountForChainSend(amount) }],
      invocationId,
    });
    ok = true;
  } catch (e) {
    console.error(e);
    ok = false;
  }
  await ctx.log.append({
    type: "execute_result",
    stage: "executed",
    invocationId,
    toolId,
    ok,
    address,
    amount,
    wallet_to_send_from_pa,
  });
}

async function accept_no(ctx: ToolWorkerContext, invocationId: string) {
  const tip = await ctx.log.getTip(invocationId);
  if (
    !tip ||
    tip.type === "dismiss" ||
    tip.type === "execute_result" ||
    tip.type === "aborted"
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
  },
  worker: {
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
