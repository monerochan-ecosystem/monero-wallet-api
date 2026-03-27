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
export type ParsedMoneroToolInvocation = {
  tool: MoneroTool;
  destination_domain: string;
  context_domain: string;
  found_in: "link" | "linkText";
  link: string;
  linkText: string;
  timestamp: number;
  context_href: string;
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
      context_href,
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
        context_href,
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
  const address = args[1];
  const amount = args[3];
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
