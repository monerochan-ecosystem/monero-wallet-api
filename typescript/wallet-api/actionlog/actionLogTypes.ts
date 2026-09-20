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

export type InvocationDisplayStatus =
  | "done"
  | "dismissed"
  | "aborted"
  | "failed"
  | "in progress";

export class Invocation {
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
  events: ActionLogEvent[];

  /** an Invocation from stored fields or from advanceInvo. */
  constructor(init: {
    invocationId: string;
    toolId: ToolId;
    stage: ActionLogStage;
    lastType: ActionLogEventType;
    events?: ActionLogEvent[];
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
  }) {
    this.invocationId = init.invocationId;
    this.toolId = init.toolId;
    this.stage = init.stage;
    this.lastType = init.lastType;
    this.events = init.events ?? [];
    if (init.valid !== undefined) this.valid = init.valid;
    if (init.amount !== undefined) this.amount = init.amount;
    if (init.address !== undefined) this.address = init.address;
    if (init.no_check !== undefined) this.no_check = init.no_check;
    if (init.wallet_slot !== undefined) this.wallet_slot = init.wallet_slot;
    if (init.context_domain !== undefined)
      this.context_domain = init.context_domain;
    if (init.destination_domain !== undefined)
      this.destination_domain = init.destination_domain;
    if (init.context_href !== undefined) this.context_href = init.context_href;
    if (init.found_in !== undefined) this.found_in = init.found_in;
    if (init.link !== undefined) this.link = init.link;
    if (init.linkText !== undefined) this.linkText = init.linkText;
    if (init.timestamp !== undefined) this.timestamp = init.timestamp;
    if (init.wallet_to_send_from_pa !== undefined)
      this.wallet_to_send_from_pa = init.wallet_to_send_from_pa;
    if (init.ok !== undefined) this.ok = init.ok;
    if (init.error !== undefined) this.error = init.error;
  }

  /** the label on the list and detail pages.  */
  get status(): InvocationDisplayStatus {
    if (this.lastType === "execute_result") return "done";
    if (this.lastType === "dismiss") return "dismissed";
    if (this.lastType === "aborted") return "aborted";
    if (this.lastType === "execute_error") return "failed";
    return "in progress";
  }
}

export type InvocationState = Invocation;

export const TERMINAL_EVENT_TYPES: ReadonlySet<ActionLogEventType> = new Set([
  "dismiss",
  "execute_result",
  "aborted",
]);
// dismiss, execute_result, and aborted end the invocation.
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

/** apply one event to the current invocation state. advances invocation state. */
export function advanceInvo(
  prev: InvocationState | null,
  event: ActionLogEvent,
): InvocationState {
  const next = new Invocation({
    ...(prev ?? {
      invocationId: event.invocationId,
      toolId: event.toolId,
      stage: event.stage,
      lastType: event.type,
      events: [],
    }),
    invocationId: event.invocationId,
    toolId: event.toolId,
    stage: event.stage,
    lastType: event.type,
    timestamp: event.timestamp,
    events: [...(prev?.events ?? []), event],
  });
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

/** still live. false for dismiss, execute_result, aborted. */
export function isActive(state: InvocationState): boolean {
  return !isTerminalEventType(state.lastType);
}

export type InvocationStatus = "active" | ActionLogEventType;

/** the status column: active, or lastType when the invocation ended. */
export function invocationStatus(state: InvocationState): InvocationStatus {
  return isActive(state) ? "active" : state.lastType;
}

export type ActionLogBackend = {
  append(event: ActionLogEvent): Promise<void>;
  invocation(invocationId: string): Promise<InvocationState | null>;
  invocations(status?: InvocationStatus): Promise<InvocationState[]>;
  feed?(events: ActionLogEvent[]): Promise<void>;
  reload?(): Promise<void>;
};
// current invos in memory. mininext reads this once per frame.
export class ActiveInvocations {
  byInvocation = new Map<string, InvocationState>();
  byTool = new Map<ToolId, string>();

  /** update the invo for this event. byTool keeps one live invo per tool. */
  apply(event: ActionLogEvent) {
    const prev = this.byInvocation.get(event.invocationId) ?? null;
    const next = advanceInvo(prev, event);
    this.byInvocation.set(event.invocationId, next);
    if (isActive(next)) {
      this.byTool.set(event.toolId, event.invocationId);
      return next;
    }
    if (this.byTool.get(event.toolId) === event.invocationId) {
      this.byTool.delete(event.toolId);
    }
    return next;
  }

  /** invocations from sqlite or idb into byInvocation and byTool. */
  loadStates(states: InvocationState[]) {
    this.clear();
    for (const state of states) {
      const invo = new Invocation({
        ...state,
        events: state.events ?? [],
      });
      this.byInvocation.set(invo.invocationId, invo);
      if (isActive(invo)) this.byTool.set(invo.toolId, invo.invocationId);
    }
  }

  clear() {
    this.byInvocation.clear();
    this.byTool.clear();
  }

  /** the invocation for this id. */
  invocation(invocationId: string): InvocationState | null {
    return this.byInvocation.get(invocationId) ?? null;
  }

  /** all invocations, or filter. active reads byTool (one live invo per tool). */
  invocations(status?: InvocationStatus): InvocationState[] {
    if (status === "active") {
      const out: InvocationState[] = [];
      for (const id of this.byTool.values()) {
        const s = this.byInvocation.get(id);
        if (s) out.push(s);
      }
      return out;
    }
    const all = [...this.byInvocation.values()];
    if (!status) return all;
    return all.filter((s) => invocationStatus(s) === status);
  }
}
