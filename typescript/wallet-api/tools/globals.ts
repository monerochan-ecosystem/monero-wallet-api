import type { ActionLogEvent, InvocationState, ToolWorkerContext } from "../actionlog/actionLogTypes";
import type { TransactionFeeOptions } from "../send-functionality/transactionBuilding";

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
  openSidebar: { metadata: Record<string, unknown>; windowId?: number } | null;
  takeSidebarMetadata: { windowId: number };
  sidebarMetadataChanged: { windowId: number };
  "tabs.create": { url: string };
  actionLogChanged: null;
  walletCacheChanged: string;
  walletsChanged: { scan_settings_path: string };
  "worker.setNodeUrl": { node_url?: string };
  "worker.setStartHeight": { start_height?: number | null };
  "worker.changeNodeUrlAndStartHeight": {
    node_url?: string;
    start_height?: number | null;
  };
  "worker.buildWallets": null;
  "worker.stopWorker": null;
  "worker.makeSignSend": TransactionFeeOptions & {
    primary_address: string;
    payments: { address: string; amount: string }[];
    input_indexes: string[];
  };
  "worker.sweepSignSend": TransactionFeeOptions & {
    primary_address: string;
    address: string;
    input_indexes: string[];
  };
  "worker.rebroadcastTx": {
    primary_address: string;
    tx_log_index: number;
  };
  "worker.releaseInputs": {
    primary_address: string;
    tx_log_index: number;
  };
  "worker.dismissSendPlate": {
    primary_address: string;
    tx_log_index?: number;
  };
  "worker.setLogSettings": {
    logs?: "console" | "file" | "console-and-file" | "off" | null;
    logs_include?: string[] | null;
    logs_exclude?: string[] | null;
  };
  "worker.getTxLogs": null;
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
  sender?: { tab?: { id?: number }; frameId?: number; url?: string };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void; removeListener?: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void; removeListener?: (cb: () => void) => void };
};

export type ExtensionRuntime = {
  sendMessage: (msg: unknown) => Promise<unknown>;
  connect: (info: { name: string }) => ExtensionPort;
  getURL: (path: string) => string;
  onMessage: {
    addListener: (cb: (msg: unknown, sender: unknown, reply?: (value: unknown) => void) => void | boolean) => void;
  };
  onConnect: { addListener: (cb: (port: ExtensionPort) => void) => void };
};

// the parts of the extension namespace that wallet pages use.
export type ExtensionBrowser = {
  runtime: ExtensionRuntime;
  sidebarAction?: { open: () => Promise<void> };
  sidePanel?: { open: (options: { windowId: number }) => Promise<void> };
  windows?: { getCurrent: () => Promise<{ id?: number }> };
  tabs: {
    create: (options: { url: string }) => Promise<{ id?: number }>;
    query: (query: { url?: string }) => Promise<{ id?: number }[]>;
    remove: (ids: number[]) => Promise<void>;
    update: (
      id: number,
      update: { url?: string; active?: boolean },
    ) => Promise<unknown>;
  };
};

export function getExtensionBrowser(): ExtensionBrowser | undefined {
  const g = globalThis as unknown as { browser?: ExtensionBrowser; chrome?: ExtensionBrowser };
  return g.browser ?? g.chrome;
}

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
  handover: { handoverUrl: string; tx_as_hex: string };
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
  install?: () => void;
};

export type ToolWorkerZone = {
  /** check an event against the current state just before applying it. */
  should_apply_event?: (current: InvocationState, event: ActionLogEvent) => boolean;
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
