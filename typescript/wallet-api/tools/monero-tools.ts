import {
  TOOL_MAGIC_STRING,
  type ToolArm,
  type ToolInvocationValidity,
  type ToolPermission,
  type ToolUiCopy,
} from "./globals";
import tool001 from "./calls/001";
import tool002 from "./calls/002";

export { TOOL_MAGIC_STRING, type ToolInvocationValidity };
export type {
  ToolArm,
  ToolContentZone,
  ToolCounterpartyZone,
  ToolInvocationForValidate,
  ToolWorkerZone,
} from "./globals";
export type {
  ToolUiCopy,
  ToolNotice,
  ToolPermission,
} from "./globals";

// add a tool: import + one key here
export const tools = {
  "001": tool001,
  "002": tool002,
} as const satisfies Record<string, ToolArm<any>>;

export type ToolId = keyof typeof tools;
export const TOOL_IDS = Object.keys(tools) as ToolId[];

export function getToolUiByPermissions(
  permissions: ToolPermission[],
): ToolUiCopy | null {
  const want = new Set(permissions);
  for (const id of Object.keys(tools) as ToolId[]) {
    const arm = tools[id];
    if (!arm.permissions.some((p) => want.has(p as ToolPermission))) continue;
    if (arm.ui) return arm.ui;
  }
  return null;
}

type PayloadOf<A> = A extends ToolArm<infer P, infer _E> ? P : never;
export type MoneroTool = {
  [K in ToolId]: { tool_id: K; payload: PayloadOf<(typeof tools)[K]> };
}[ToolId];

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

function isToolId(id: string): id is ToolId {
  return id in tools;
}

export function parseToolLink(link: string): MoneroTool | null {
  const magic_str_index = link.lastIndexOf(TOOL_MAGIC_STRING);
  if (magic_str_index === -1) return null;
  const link_start_index = magic_str_index + TOOL_MAGIC_STRING.length;
  const tool_id = link.substring(link_start_index, link_start_index + 3);
  if (!isToolId(tool_id)) return null;
  const args = link
    .substring(link_start_index + 3)
    .split("_")
    .slice(1);
  const parsed = tools[tool_id].content.recognize_parse(args);
  return (parsed as MoneroTool | null) ?? null;
}

export function createToolLink(tool: MoneroTool): string {
  const id = tool.tool_id as ToolId;
  if (!isToolId(id)) throw new Error("unknown tool");
  return tools[id].counterparty.make(tool.payload as never);
}

export function parseToolInvocation(
  link: string,
  linkText: string,
  context_location: Location,
): ParsedMoneroToolInvocation | null {
  const context_domain = getDomainWithTLD(context_location.hostname);
  const context_href = context_location.href;
  const link_parse = parseToolLink(link);
  if (link_parse) {
    return {
      tool: link_parse,
      destination_domain: parseDestination(link),
      context_domain,
      found_in: "link",
      link,
      linkText,
      timestamp: Date.now(),
      invocation_id: crypto.randomUUID(),
      context_href,
      valid: "unverified",
    };
  }
  const linkText_parse = parseToolLink(linkText);
  if (linkText_parse) {
    return {
      tool: linkText_parse,
      destination_domain: parseDestination(linkText),
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
  return null;
}

export async function checkToolInvocationValidity(
  invo: ParsedMoneroToolInvocation,
): Promise<ToolInvocationValidity> {
  const id = invo.tool.tool_id as ToolId;
  if (!isToolId(id)) return "unverified";
  const check = tools[id].content.validate_check;
  if (!check) return "unverified";
  return check(invo);
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
