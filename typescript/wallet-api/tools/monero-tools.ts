import {
  TOOL_MAGIC_STRING,
  type ToolInvocationValidity,
} from "./globals";
import tool001, {
  parseSendTransactionToolArgs,
  createSendTransactionToolLink,
  type SendTransactionTool,
} from "./calls/001";
import tool002, {
  parseCreateAndShareViewOnlyWalletToolArgs,
  createCreateAndShareViewOnlyWalletToolLink,
  type CreateAndShareViewOnlyWalletTool,
} from "./calls/002";

export { TOOL_MAGIC_STRING, type ToolInvocationValidity };

export const tools = {
  "001": tool001,
  "002": tool002,
};
export type ToolId = keyof typeof tools;
export const TOOL_IDS = Object.keys(tools) as ToolId[];
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

export type { SendTransactionTool, SendTransactionToolPayload } from "./calls/001";
export {
  parseSendTransactionToolArgs,
  createSendTransactionToolLink,
  make001ToolLink,
  ADDRESS_VALID_RESPONSE,
  ADDRESS_INVALID_RESPONSE,
} from "./calls/001";

export type {
  CreateAndShareViewOnlyWalletTool,
  CreateAndShareViewOnlyWalletToolPayload,
  ShareViewkeyPayload,
  ShareViewkeyResult,
  ShareViewkey002Pruned,
} from "./calls/002";
export {
  parseCreateAndShareViewOnlyWalletToolArgs,
  createCreateAndShareViewOnlyWalletToolLink,
  make002ToolLink,
  shareViewKey002,
  potentialSuccessRedirect002,
  handle002ShareRequest,
} from "./calls/002";

export type MoneroTool = SendTransactionTool | CreateAndShareViewOnlyWalletTool;
export function createToolLink(tool: MoneroTool): string {
  if (tool.tool_id === "001") {
    return createSendTransactionToolLink(
      tool.payload.address,
      tool.payload.amount,
      tool.payload.no_check,
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
// this validity check should happen in the contentscript when the link is clicked,
// not in the background script
// -> tor circuit is separated & compartmentalized
export async function checkToolInvocationValidity(
  invo: ParsedMoneroToolInvocation,
): Promise<ToolInvocationValidity> {
  // send 001 fetch from destination domain to check if the address is valid
  // _no_check on the wire skips the GET and leaves validity unverified
  if (invo.tool.tool_id == "001") {
    if (invo.tool.payload.no_check) {
      return "unverified";
    }
    const link = invo[invo.found_in];
    const invo_link = new URL(link);
    const checkUrl = `${invo_link.origin}/monerochan001/${
      invo.tool.payload.address
    }`;
    try {
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
