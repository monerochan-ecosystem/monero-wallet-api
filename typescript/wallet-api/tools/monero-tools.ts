import {
  TOOL_MAGIC_STRING,
  type ToolArm,
  type ToolInvocationValidity,
  type ToolPermission,
  type ToolUiCopy,
} from "./globals";
import tool001 from "./calls/001";
import tool002 from "./calls/002";
import { publicSuffixRules } from "./public-suffix-list";

const publicSuffixSet = new Set<string>(publicSuffixRules);

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
  // lower case, then split on "." and drop empty pieces from a stray dot
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  // for localhost or single-part hostnames, return as-is
  if (parts.length <= 1) return hostname;

  // if nothing in the list matches, the psl says pretend the rule was "*". the suffix is the last label only.
  let suffixLen = 1;
  // exception rules are the lines that start with "!". null until one of those lines matches.
  let exceptionLen: number | null = null;
  // i walks left to right, but we never test the left side by itself.
  // first pass is the whole name. each next pass chops one word off the left, so the ending gets shorter.
  for (let i = 0; i < parts.length; i++) {
    // shop.example.co.uk is checked as itself, then example.co.uk, then co.uk, then uk.
    // co.uk.evil.com never produces the tail "co.uk", because those words are not the ending.
    const tail = parts.slice(i).join(".");
    // the labels to the right of the first label of this ending. "foo.ck" gives "ck".
    const parent = parts.slice(i + 1).join(".");
    // how many labels this ending has. starts big, shrinks by one each pass.
    const len = parts.length - i;
    // exception rule, file line "!www.ck". the "!" is only the first character of that line.
    // the name after it is not a public suffix. the suffix is the rest, so save one less label.
    // the first hit is the longest. a later, shorter exception must not replace it.
    if (exceptionLen === null && publicSuffixSet.has("!" + tail)) {
      exceptionLen = len - 1;
    }
    // exact rule, file line "co.uk". the whole ending is the public suffix.
    // keep it only when it has more labels than the suffix already saved. "uk" must not replace "co.uk".
    if (publicSuffixSet.has(tail) && len > suffixLen) suffixLen = len;
    // wildcard rule, file line "*.ck". the "*" is one label, and only the leftmost label of the rule.
    // "foo.ck" lines up with "*.ck", so the lookup string is "*." plus parent "ck".
    // keep it only when that lined-up suffix is longer than the one already saved.
    if (parent && publicSuffixSet.has("*." + parent) && len > suffixLen) {
      suffixLen = len;
    }
  }
  // the psl prevailing rule: an exception wins even when an exact or wildcard match is longer.
  // "*.ck" would make the suffix "www.ck". "!www.ck" makes the suffix "ck" instead.
  if (exceptionLen !== null) suffixLen = exceptionLen;
  // the whole name is already the public suffix, like "co.uk". no label sits to the left of it.
  if (suffixLen >= parts.length) return parts.join(".");
  // take the last 2 parts (domain + tld).
  // keep the suffix plus the one word on its left. a 2-word suffix co.uk keeps example.co.uk
  return parts.slice(-(suffixLen + 1)).join(".");
}

export function parseDestination(destination: string): string {
  const url = new URL(destination);
  return getDomainWithTLD(url.hostname);
}
