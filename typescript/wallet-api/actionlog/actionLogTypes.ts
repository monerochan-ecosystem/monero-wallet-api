import type { ToolId } from "../tools/monero-tools";
import type {
  ExtensionPort,
  ToolInvocationValidity,
  ToolPermission,
} from "../tools/globals";
import type { ActionLogOpened } from "./actionLogOpened";

export type { ToolPermission };

export type ActionLogEventType =
  | "session_start"
  | "validate_start"
  | "validate_result"
  | "accept"
  | "dismiss"
  | "execute_start"
  | "execute_error"
  | "execute_result"
  | "aborted";

export type ActionLogStage =
  | "recognized"
  | "invoked"
  | "validated"
  | "accepted"
  | "executed";

export type ActionLogEvent = {
  type: ActionLogEventType;
  id: string;
  timestamp: string;
  invocationId: string;
  stage: ActionLogStage;
  toolId: ToolId;
  valid?: ToolInvocationValidity;
  amount?: string;
  address?: string;
  no_check?: boolean;
  wallet_slot?: number;
  context_domain?: string;
  destination_domain?: string;
  context_href?: string;
  found_in?: "link" | "linkText";
  link?: string;
  linkText?: string;
  wallet_to_send_from_pa?: string;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
};

export type InvocationState = {
  invocationId: string;
  toolId: ToolId;
  stage: ActionLogStage;
  lastType: ActionLogEventType;
  valid?: ToolInvocationValidity;
  amount?: string;
  address?: string;
  no_check?: boolean;
  wallet_slot?: number;
  context_domain?: string;
  destination_domain?: string;
  context_href?: string;
  found_in?: "link" | "linkText";
  link?: string;
  linkText?: string;
  timestamp?: string;
  wallet_to_send_from_pa?: string;
  ok?: boolean;
  error?: string;
};

export const TERMINAL_EVENT_TYPES: ReadonlySet<ActionLogEventType> = new Set([
  "dismiss",
  "execute_result",
  "aborted",
]);
// an event that makes an invo not active anymore 
export function isTerminalEventType(type: ActionLogEventType): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

export function newEventId(): string {
  return crypto.randomUUID();
}

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export type ToolWorkerContext = {
  log: ActionLogOpened;
  getWallets?: () => unknown;
  reloadWallets?: () => void | Promise<void>;
  getPort: (invocationId: string) => ExtensionPort | undefined;
};

// apply event to state. the invocation holds a state; this advances that state.
export function advanceInvo(
  prev: InvocationState | null,
  event: ActionLogEvent,
): InvocationState {
  const base: InvocationState = prev ?? {
    invocationId: event.invocationId,
    toolId: event.toolId,
    stage: event.stage,
    lastType: event.type,
  };
  const next: InvocationState = {
    ...base,
    invocationId: event.invocationId,
    toolId: event.toolId,
    stage: event.stage,
    lastType: event.type,
    timestamp: event.timestamp,
  };
  if (event.valid !== undefined) next.valid = event.valid;
  if (event.amount !== undefined) next.amount = event.amount;
  if (event.address !== undefined) next.address = event.address;
  if (event.no_check !== undefined) next.no_check = event.no_check;
  if (event.wallet_slot !== undefined) next.wallet_slot = event.wallet_slot;
  if (event.context_domain !== undefined)
    next.context_domain = event.context_domain;
  if (event.destination_domain !== undefined)
    next.destination_domain = event.destination_domain;
  if (event.context_href !== undefined) next.context_href = event.context_href;
  if (event.found_in !== undefined) next.found_in = event.found_in;
  if (event.link !== undefined) next.link = event.link;
  if (event.linkText !== undefined) next.linkText = event.linkText;
  if (event.wallet_to_send_from_pa !== undefined)
    next.wallet_to_send_from_pa = event.wallet_to_send_from_pa;
  if (event.ok !== undefined) next.ok = event.ok;
  if (event.error !== undefined) next.error = event.error;
  return next;
}

export function isActive(state: InvocationState): boolean {
  return !isTerminalEventType(state.lastType);
}

export type ActionLogBackend = {
  append(event: ActionLogEvent): Promise<void>;
  getBranch(invocationId: string): Promise<ActionLogEvent[]>;
  getTip(invocationId: string): Promise<ActionLogEvent | null>;
  getActiveByToolId(toolId: ToolId): Promise<InvocationState | null>;
  getActiveInvocations(): Promise<InvocationState[]>;
  feed?(events: ActionLogEvent[]): Promise<void>;
  reload?(): Promise<void>;
  close?(): Promise<void>;
};

// active invocations from the log, by id and by tool. 
// a jsonl file is only a list of events. it cannot tell you what is still active.
// walk the events into this object and keep it up to date on each append.
export class ActiveInvocations {
  byInvocation = new Map<string, InvocationState>();
  byTool = new Map<ToolId, string>();

  apply(event: ActionLogEvent) {
    const prev = this.byInvocation.get(event.invocationId) ?? null;
    const next = advanceInvo(prev, event);
    if (!isActive(next)) {
      this.byInvocation.delete(event.invocationId);
      if (this.byTool.get(event.toolId) === event.invocationId) {
        this.byTool.delete(event.toolId);
      }
      return;
    }
    this.byInvocation.set(event.invocationId, next);
    this.byTool.set(event.toolId, event.invocationId);
  }

  clear() {
    this.byInvocation.clear();
    this.byTool.clear();
  }

  getActiveByToolId(toolId: ToolId): InvocationState | null {
    const id = this.byTool.get(toolId);
    if (!id) return null;
    return this.byInvocation.get(id) ?? null;
  }

  getActiveInvocations(): InvocationState[] {
    return [...this.byInvocation.values()];
  }
}
