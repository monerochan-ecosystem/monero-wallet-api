import type { ScanSettingOpened } from "../api";
import { convertAmountBigIntThrows } from "../send-functionality/conversion";

export const TOOL_MAGIC_STRING = "monerochan";
export function parseToolLink(link: string): MoneroTool | null {
  const magic_str_index = link.lastIndexOf(TOOL_MAGIC_STRING);
  if (magic_str_index !== -1) {
    const link_start_index = magic_str_index + TOOL_MAGIC_STRING.length;

    const tool_id = link.substring(link_start_index, link_start_index + 3);
    const args = link
      .substring(link_start_index + 3)
      .split("_")
      .slice(1);
    if (tool_id === "001") return parseSendTransactionToolArgs(args);
    if (tool_id === "002")
      return parseCreateAndShareViewOnlyWalletToolArgs(args);
  }
  return null;
}
export type ToolInvocationValidity = "valid" | "invalid" | "unverified";
export type ParsedMoneroToolInvocation = {
  tool: MoneroTool;
  destination_domain: string;
  context_domain: string;
  found_in: "link" | "linkText";
  link: string;
  linkText: string;
  timestamp: number;
  invocation_id: string;
  context_href: string;
  valid: ToolInvocationValidity;
};
export function parseToolInvocation(
  link: string,
  linkText: string,
  context_location: Location,
): ParsedMoneroToolInvocation | null {
  const context_domain = getDomainWithTLD(context_location.hostname);
  const context_href = context_location.href;
  const link_parse = parseToolLink(link);
  if (link_parse) {
    const destination_domain = parseDestination(link);

    return {
      tool: link_parse,
      destination_domain,
      context_domain,
      found_in: "link",
      link,
      linkText,
      timestamp: Date.now(),
      invocation_id: crypto.randomUUID(),
      context_href,
      valid: "unverified",
    };
  } else {
    const linkText_parse = parseToolLink(linkText);
    if (linkText_parse) {
      const destination_domain = parseDestination(linkText);
      return {
        tool: linkText_parse,
        destination_domain,
        context_domain,
        found_in: "linkText",
        link,
        linkText,
        timestamp: Date.now(),
        invocation_id: crypto.randomUUID(),
        context_href,
        valid: "unverified",
      };
    }
  }

  return null;
}
export type SendTransactionTool = {
  tool_id: "001";
  payload: SendTransactionToolPayload;
};
export type SendTransactionToolPayload = {
  address: string;
  amount: string;
};
export function parseSendTransactionToolArgs(
  args: string[],
): SendTransactionTool | null {
  const amount = args[1];
  const address = args[3];
  try {
    convertAmountBigIntThrows(amount);
  } catch (e) {
    return null;
  }
  if (address && amount) {
    return {
      tool_id: "001",
      payload: {
        address,
        amount,
      },
    };
  }
  return null;
}
export function createSendTransactionToolLink(
  address: string,
  amount: string,
): string {
  convertAmountBigIntThrows(amount);
  return `${TOOL_MAGIC_STRING}001_amount_${amount}_address_${address}`;
}
export function make001ToolLink(address: string, amount: string): string {
  return createSendTransactionToolLink(address, amount);
}

export type CreateAndShareViewOnlyWalletTool = {
  tool_id: "002";
  payload: CreateAndShareViewOnlyWalletToolPayload;
};
export type CreateAndShareViewOnlyWalletToolPayload = {
  wallet_slot: number;
};
export function parseCreateAndShareViewOnlyWalletToolArgs(
  args: string[],
): CreateAndShareViewOnlyWalletTool | null {
  const wallet_slot = args[5];
  if (wallet_slot && !isNaN(parseInt(wallet_slot))) {
    return {
      tool_id: "002",
      payload: {
        wallet_slot: parseInt(wallet_slot),
      },
    };
  }
  return null;
}
export function createCreateAndShareViewOnlyWalletToolLink(
  wallet_slot?: number,
): string {
  wallet_slot = Number(wallet_slot) || 0;
  return `${TOOL_MAGIC_STRING}002_create_and_share_viewkey_slot_${wallet_slot}`;
}
export function make002ToolLink(wallet_slot?: number): string {
  return createCreateAndShareViewOnlyWalletToolLink(wallet_slot);
}

export type MoneroTool = SendTransactionTool | CreateAndShareViewOnlyWalletTool;
export function createToolLink(tool: MoneroTool): string {
  if (tool.tool_id === "001") {
    return createSendTransactionToolLink(
      tool.payload.address,
      tool.payload.amount,
    );
  }
  if (tool.tool_id === "002") {
    return createCreateAndShareViewOnlyWalletToolLink(tool.payload.wallet_slot);
  }
  throw new Error("unknown tool");
}

export function getDomainWithTLD(hostname: string): string {
  const parts = hostname.split(".");
  // For localhost or single-part hostnames, return as-is
  if (parts.length <= 1) return hostname;
  // Take the last 2 parts (domain + tld).
  return parts.slice(-2).join(".");
}

export function parseDestination(destination: string): string {
  const url = new URL(destination);
  return getDomainWithTLD(url.hostname);
}
export const OPEN_DOMAINS = ["monerochan.city"];
// this validity check should happen in the contentscript when the link is clicked,
// not in the background script
// -> tor circuit is separated & compartmentalized
export async function checkToolInvocationValidity(
  invo: ParsedMoneroToolInvocation,
): Promise<ToolInvocationValidity> {
  // send 001 fetch from destination domain to check if the address is valid
  if (invo.tool.tool_id == "001") {
    const link = invo[invo.found_in];
    const invo_link = new URL(link);
    const checkUrl = `${invo_link.origin}/monerochan001/${
      invo.tool.payload.address
    }`;
    try {
      if (invo.destination_domain === OPEN_DOMAINS[0]) {
        return "unverified";
      }
      const result = (await (await fetch(checkUrl)).json()) as unknown;
      if (
        result &&
        typeof result === "object" &&
        "valid_address" in result &&
        result.valid_address === true
      ) {
        return "valid";
      } else {
        return "invalid";
      }
    } catch {
      return "invalid";
    }
  }

  // create view only wallet 002 make sure context + destination domain is the same
  if (invo.tool.tool_id == "002") {
    if (invo.context_domain == invo.destination_domain) {
      return "valid";
    } else {
      return "invalid";
    }
  }

  return "unverified";
}

export const ADDRESS_VALID_RESPONSE = {
  valid_address: true,
} as const;

export const ADDRESS_INVALID_RESPONSE = {
  valid_address: false,
} as const;

export type ShareViewkeyPayload = {
  viewkey: string;
  primary_address: string;
  tool_invo: ParsedMoneroToolInvocation;
};
export type ShareViewkeyResult = {
  ok: boolean;
  successUrl: string | null;
};
export async function shareViewKey002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult> {
  const invo = payload.tool_invo;
  if (invo.tool.tool_id !== "002")
    return {
      ok: false,
      successUrl: null,
    };
  if (invo.valid !== "valid")
    return {
      ok: false,
      successUrl: null,
    };
  const link = invo[invo.found_in];
  const invo_link = new URL(link);
  const shareVKUrl = `${invo_link.origin}/monerochan002/`;
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
    const data = (await result.json()) as {
      ok: boolean;
      successUrl?: string | null;
    };
    if (data && typeof data === "object" && "ok" in data && data.ok === true) {
      return {
        ok: true,
        successUrl: data.successUrl ?? null,
      };
    } else {
      return {
        ok: false,
        successUrl: null,
      };
    }
  } else {
    return {
      ok: false,
      successUrl: null,
    };
  }
}
export type ShareViewkey002Pruned = {
  viewkey: string;
  primary_address: string;
  wallet_slot: number;
};
// client wallet side
export async function potentialSuccessRedirect002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult | undefined> {
  const shareVKresult = await shareViewKey002(payload);
  if (shareVKresult.ok && shareVKresult.successUrl) {
    window.location.href = shareVKresult.successUrl;
    window.location.reload();
  } else {
    return shareVKresult;
  }
}

// backend response

export async function handle002ShareRequest(
  req: Request,
  wallets: ScanSettingOpened[],
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
      if (foundSlot.secret_view_key !== viewkey) {
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
