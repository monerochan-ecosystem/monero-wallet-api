import type { ToolWorkerContext } from "../actionlog/actionLogTypes";

export const TOOL_MAGIC_STRING = "monerochan";
export type ToolInvocationValidity = "valid" | "invalid" | "unverified";

// chrome runtime.sendMessage / sendToBackground. kind -> payload.
export type ExtensionMessageByKind = {
  toolCall: {
    tool: { tool_id: string; payload: unknown };
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
  execute: { invocationId: string; args?: Record<string, unknown> };
  dismiss: { invocationId: string };
  dismissNotice: { noticeId: string };
  openSidebar: null;
  actionLogChanged: { events?: unknown[] };
  walletCacheChanged: string;
  "worker.setNodeUrl": { node_url?: string };
  "worker.setStartHeight": { start_height?: number | null };
  "worker.changeNodeUrlAndStartHeight": {
    node_url?: string;
    start_height?: number | null;
  };
  "worker.buildWallets": null;
  "worker.wipeWorkers": null;
  shareViewkeyOK: { invocationId: string };
  shareViewkeyFAILED: {
    viewkey: string;
    primary_address: string;
    error?: string;
    tool_invo: {
      tool: { tool_id: string; payload: unknown };
      found_in: "link" | "linkText";
      link: string;
      linkText: string;
      valid: ToolInvocationValidity;
    };
  };
};

export type ExtensionMessageKind = keyof ExtensionMessageByKind;

export type ToolPermission = "spend" | "share_view";

// phrases for wallet ui views, part of tool definition
export type ToolNotice = {
  id: string;
  permission: ToolPermission;
  title: string;
  message: string;
  context_domain?: string;
  context_href?: string;
  wallet_slot?: number;
  timestamp?: number | string;
};

export type ToolUiCopy = {
  openTitle: string;
  acceptLabel?: string;
  dismissLabel?: string;
};

export type ExtensionPort = {
  name: string;
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
};

export type ExtensionRuntime = {
  sendMessage: (msg: unknown) => Promise<unknown>;
  connect: (info: { name: string }) => ExtensionPort;
  onMessage: {
    addListener: (cb: (msg: unknown, sender: unknown) => void) => void;
  };
  onConnect: { addListener: (cb: (port: ExtensionPort) => void) => void };
};

export function getExtensionRuntime(): ExtensionRuntime | null {
  const g = globalThis as unknown as {
    browser?: { runtime?: ExtensionRuntime };
    chrome?: { runtime?: ExtensionRuntime };
  };
  return g.browser?.runtime ?? g.chrome?.runtime ?? null;
}

export function sendToBackground<K extends ExtensionMessageKind>(
  kind: K,
  payload: ExtensionMessageByKind[K],
): Promise<unknown> {
  const rt = getExtensionRuntime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return rt.sendMessage({ kind, payload });
}

export type PortMessageByKind = {
  shareViewkey: {
    viewkey: string;
    primary_address: string;
    tool_invo: {
      tool: { tool_id: string; payload: { wallet_slot: number } };
      found_in: "link" | "linkText";
      link: string;
      linkText: string;
      valid: ToolInvocationValidity;
    };
  };
};

export type PortMessageKind = keyof PortMessageByKind;

export function sendToPort<K extends PortMessageKind>(
  port: ExtensionPort,
  kind: K,
  payload: PortMessageByKind[K],
): void {
  port.postMessage({ kind, payload });
}

export type ToolInvocationForValidate = {
  tool: { tool_id: string; payload: unknown };
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

export type ToolContentZone<TPayload = unknown> = {
  recognize_parse: (args: string[]) => {
    tool_id: string;
    payload: TPayload;
  } | null;
  validate_check?: (
    invo: ToolInvocationForValidate,
  ) => Promise<ToolInvocationValidity> | ToolInvocationValidity;
  execute_deliver?: (invo: ToolInvocationForValidate) => void;
};

export type ToolWorkerZone = {
  invoke_write?: (
    ctx: ToolWorkerContext,
    invo: ToolInvocationForValidate,
  ) => Promise<void>;
  validate_write?: (
    ctx: ToolWorkerContext,
    invo: ToolInvocationForValidate,
  ) => Promise<void>;
  accept_yes?: (
    ctx: ToolWorkerContext,
    invocationId: string,
    args: Record<string, unknown>,
  ) => Promise<void>;
  accept_no?: (
    ctx: ToolWorkerContext,
    invocationId: string,
  ) => Promise<void>;
  execute_run?: (
    ctx: ToolWorkerContext,
    invocationId: string,
    args: Record<string, unknown>,
  ) => Promise<void>;
  execute_abort?: (
    ctx: ToolWorkerContext,
    invocationId: string,
  ) => Promise<void>;
  execute_ok?: (
    ctx: ToolWorkerContext,
    payload: { invocationId: string },
  ) => Promise<void>;
  execute_fail?: (
    ctx: ToolWorkerContext,
    payload: unknown,
  ) => Promise<void>;
};

export type ToolCounterpartyZone<
  TPayload = unknown,
  TExtra extends object = {},
> = {
  make: (payload: TPayload) => string;
} & TExtra;

export type ToolArm<
  TPayload = unknown,
  TCounterpartyExtra extends object = {},
> = {
  permissions: readonly ToolPermission[];
  ui: ToolUiCopy;
  content: ToolContentZone<TPayload>;
  worker: ToolWorkerZone;
  counterparty: ToolCounterpartyZone<TPayload, TCounterpartyExtra>;
};
