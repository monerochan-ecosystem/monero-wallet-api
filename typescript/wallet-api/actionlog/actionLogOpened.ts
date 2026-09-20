import {
  newEventId,
  nowTimestamp,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
  type InvocationStatus,
  type ToolPermission,
  type ToolWorkerContext,
} from "./actionLogTypes";
import { tools, type ToolId } from "../tools/monero-tools";
import type { ParsedMoneroToolInvocation } from "../tools/monero-tools";
import {
  getExtensionRuntime,
  sendToBackground,
  type ExtensionMessageKind,
  type ExtensionPort,
  type ToolNotice,
} from "../tools/globals";

export type ActionLogBackendKind = "sqlite" | "idb";
export type ExtensionMessageBus = "worker" | "ui";

export type ActionLogOpenedCreateOptions = {
  path?: string;
  backend?: ActionLogBackendKind;
  backendInstance?: ActionLogBackend;
  onChange?: (() => void) | null;
  extensionMessageBus?: ExtensionMessageBus;
};

type BoundMco = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feed: (params: any) => Promise<void>;
  wallets?: unknown;
  changeNodeUrl: (node_url: string) => Promise<void>;
  changeStartHeight: (start_height: number | null) => Promise<void>;
  changeNodeUrlAndStartHeight: (
    node_url?: string,
    start_height?: number | null,
  ) => Promise<void>;
  buildWallets: () => Promise<void>;
  stopWorker: () => Promise<void>;
};

function armWorker(toolId: ToolId) {
  return tools[toolId]?.worker;
}

export class ActionLogOpened {
  private ports = new Map<string, ExtensionPort>();
  private runtimeInstalled = false;
  private bus: ExtensionMessageBus | null = null;
  private mco: BoundMco | null = null;
  private invocationsCache: InvocationState[] = [];
  private activeCache: InvocationState[] = [];
  private noticeList: ToolNotice[] = [];
  private toolCallTail = new Map<string, Promise<void>>();

  private constructor(
    private backend: ActionLogBackend,
    private _onChange: (() => void) | null,
  ) {}

  static async create(
    options: ActionLogOpenedCreateOptions = {},
  ): Promise<ActionLogOpened> {
    const backend = await openBackend(options);
    const log = new ActionLogOpened(backend, options.onChange ?? null);
    log.bus = options.extensionMessageBus ?? null;
    if (log.bus) log.installExtensionMessagebus();
    await log.refreshUiCache();
    return log;
  }

  setOnChange(cb: (() => void) | null) {
    this._onChange = cb;
  }

  // mco wires itself after create
  bindMco(mco: BoundMco) {
    this.mco = mco;
  }

  /** after a write, the invocation lists that the plates read. */
  private async refreshUiCache() {
    this.invocationsCache = await this.backend.invocations();
    this.activeCache = await this.backend.invocations("active");
    this.noticeList = [];
    this._onChange?.();
  }

  private toolCtx(): ToolWorkerContext {
    return {
      log: this,
      getWallets: () => this.mco,
      reloadWallets: () => this.mco?.buildWallets(),
      getPort: (id: string) => this.ports.get(id),
    };
  }

  get extensionMessageBus(): ExtensionMessageBus | null {
    return this.bus;
  }

  private isUiBus(): boolean {
    return this.bus === "ui";
  }

  private broadcastActionLogChanged() {
    void sendToBackground("actionLogChanged", null).catch(() => {});
  }

  async append(
    partial: Omit<ActionLogEvent, "id" | "timestamp"> &
      Partial<Pick<ActionLogEvent, "id" | "timestamp">>,
  ): Promise<ActionLogEvent> {
    const event = {
      ...partial,
      id: partial.id ?? newEventId(),
      timestamp: partial.timestamp ?? nowTimestamp(),
    } as ActionLogEvent;
    await this.backend.append(event);
    await this.refreshUiCache();
    this.broadcastActionLogChanged();
    return event;
  }

  /** one invocation by id. sqlite and idb select by primary key. */
  async invocation(invocationId: string): Promise<InvocationState | null> {
    return this.backend.invocation(invocationId);
  }

  /** all invocations, or the active ones. */
  invocations(status?: InvocationStatus): InvocationState[] {
    if (!status) return [...this.invocationsCache];
    if (status === "active") return [...this.activeCache];
    return this.invocationsCache.filter((s) => s.lastType === status);
  }

  /** invoke and validate for one invocation id, in order. */
  async toolCall(invo: ParsedMoneroToolInvocation): Promise<void> {
    const id = invo.invocation_id;
    const prev = this.toolCallTail.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.applyToolCall(invo));
    this.toolCallTail.set(
      id,
      next.catch(() => {}),
    );
    await next;
  }

  /** first toolCall state transition: session_start invoked when no row. second state transition: validate_result validated if valid is not unverified. */
  private async applyToolCall(invo: ParsedMoneroToolInvocation) {
    const w = armWorker(invo.tool.tool_id as ToolId);
    const ctx = this.toolCtx();
    if (!(await this.invocation(invo.invocation_id)))
      await w?.invoke_write?.(ctx, invo);
    if (invo.valid !== "unverified") await w?.validate_write?.(ctx, invo);
  }

  /** open invocations for these permissions. the send and wallets plates show these. */
  getActiveByPermissions(permissions: ToolPermission[]): InvocationState[] {
    const want = new Set(permissions);
    const toolIds = (Object.keys(tools) as ToolId[]).filter((id) =>
      (tools[id].permissions as readonly string[]).some((p) =>
        want.has(p as ToolPermission),
      ),
    );
    const idSet = new Set(toolIds);
    return this.invocations("active").filter((o) => idSet.has(o.toolId));
  }

  getNoticesByPermissions(permissions: ToolPermission[]): ToolNotice[] {
    const want = new Set(permissions);
    return this.noticeList.filter((n) => want.has(n.permission));
  }

  async dismissNotice(noticeId: string): Promise<void> {
    if (this.isUiBus()) {
      await sendToBackground("dismissNotice", { noticeId }).catch(() => {});
      await this.refreshUiCache();
      return;
    }
    await this.dismissNoticeLocal(noticeId);
  }

  async dismiss(invocationId: string): Promise<void> {
    if (this.isUiBus()) {
      await sendToBackground("dismiss", { invocationId }).catch(() => {});
      return;
    }
    await this.dismissLocal(invocationId);
  }

  async execute(
    invocationId: string,
    args: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.isUiBus()) {
      await sendToBackground("execute", { invocationId, args }).catch(() => {});
      return;
    }
    await this.executeLocal(invocationId, args);
  }

  getPort(invocationId: string): ExtensionPort | undefined {
    return this.ports.get(invocationId);
  }

  private listenOnMessage(
    handle: (
      env: { kind: ExtensionMessageKind; payload: unknown },
      sender?: { tab?: { windowId?: number } },
    ) => Promise<{ events?: ActionLogEvent[] } | void>,
  ) {
    const rt = getExtensionRuntime();
    if (!rt) return;
    rt.onMessage.addListener((msg, sender: unknown, sendResponse?: (r: unknown) => void) => {
      const done = handle(
        msg as { kind: ExtensionMessageKind; payload: unknown },
        sender as { tab?: { windowId?: number } } | undefined,
      ).then((result) => {
        sendResponse?.(result ?? {});
        return result;
      });
      void done;
      return true;
    });
  }

  installExtensionMessagebus() {
    if (this.runtimeInstalled) return;
    if (this.bus === "worker") this.installWorkerMessagebus();
    else if (this.bus === "ui") this.installUiMessagebus();
  }

  private installUiMessagebus() {
    this.runtimeInstalled = true;
    this.listenOnMessage((env) => this.handleUiMessage(env));
  }

  private installWorkerMessagebus() {
    const rt = getExtensionRuntime();
    if (!rt) return;
    this.runtimeInstalled = true;
    this.listenOnMessage((env, sender) => this.handleWorkerMessage(env, sender));
    rt.onConnect.addListener((port) => {
      const invocationId = port.name;
      const existing = this.ports.get(invocationId);
      if (existing) existing.disconnect();
      this.ports.set(invocationId, port);
      port.onDisconnect.addListener(() => {
        this.ports.delete(invocationId);
        void this.dispatchPortDisconnect(invocationId);
      });
    });
  }

  private async handleUiMessage(env: {
    kind: ExtensionMessageKind;
    payload: unknown;
  }): Promise<{ events?: ActionLogEvent[] } | void> {
    if (!env?.kind) return {};
    if (env.kind === "actionLogChanged") {
      if (this.backend.reload) {
        await this.backend.reload();
        await this.refreshUiCache();
      }
      return {};
    }
    if (env.kind === "walletCacheChanged") {
      const raw =
        typeof env.payload === "string"
          ? JSON.parse(env.payload, (key, value) => {
              if (key === "amount") return BigInt(value);
              return value;
            })
          : env.payload;
      await this.mco?.feed(raw);
      return {};
    }
    return {};
  }

  private async handleWorkerMessage(
    env: { kind: ExtensionMessageKind; payload: unknown },
    sender?: { tab?: { windowId?: number } },
  ): Promise<{ events?: ActionLogEvent[] } | void> {
    if (!env?.kind) return {};
    const ctx = this.toolCtx();
    switch (env.kind) {
      case "openSidebar":
        this.openWalletUi(sender);
        return {};
      case "worker.setNodeUrl": {
        const p = env.payload as { node_url?: string };
        if (p?.node_url != null)
          await this.mco?.changeNodeUrl(p.node_url);
        return {};
      }
      case "worker.setStartHeight": {
        const p = env.payload as { start_height?: number | null };
        if (p && "start_height" in p)
          await this.mco?.changeStartHeight(p.start_height ?? null);
        return {};
      }
      case "worker.changeNodeUrlAndStartHeight": {
        const p = env.payload as {
          node_url?: string;
          start_height?: number | null;
        };
        await this.mco?.changeNodeUrlAndStartHeight(
          p?.node_url,
          p?.start_height,
        );
        return {};
      }
      case "worker.buildWallets":
        await this.mco?.buildWallets();
        return {};
      case "worker.stopWorker":
        await this.mco?.stopWorker();
        return {};
      case "toolCall": {
        await this.toolCall(env.payload as ParsedMoneroToolInvocation);
        return {};
      }
      case "dismiss": {
        const p = env.payload as { invocationId: string };
        await this.dismissLocal(p.invocationId);
        return {};
      }
      case "execute": {
        const p = env.payload as {
          invocationId: string;
          args?: Record<string, unknown>;
        };
        await this.executeLocal(p.invocationId, p.args ?? {});
        return {};
      }
      case "dismissNotice": {
        const p = env.payload as { noticeId: string };
        await this.dismissNoticeLocal(p.noticeId);
        return {};
      }
      case "shareViewkeyOK": {
        const p = env.payload as { invocationId: string };
        for (const id of Object.keys(tools) as ToolId[]) {
          await armWorker(id)?.execute_ok?.(ctx, p);
        }
        return {};
      }
      case "shareViewkeyFAILED": {
        for (const id of Object.keys(tools) as ToolId[]) {
          await armWorker(id)?.execute_fail?.(ctx, env.payload);
        }
        return {};
      }
      default:
        return {};
    }
  }

  private async dismissLocal(invocationId: string) {
    const invo = await this.invocation(invocationId);
    if (!invo) return;
    await armWorker(invo.toolId)?.accept_no?.(this.toolCtx(), invocationId);
  }

  private async executeLocal(
    invocationId: string,
    args: Record<string, unknown>,
  ) {
    const invo = await this.invocation(invocationId);
    if (!invo) return;
    const w = armWorker(invo.toolId);
    const ctx = this.toolCtx();
    await w?.accept_yes?.(ctx, invocationId, args);
    await w?.execute_run?.(ctx, invocationId, args);
  }

  private async dismissNoticeLocal(_noticeId: string) {
    await this.refreshUiCache();
  }

  private openWalletUi(sender?: { tab?: { windowId?: number } }) {
    const g = globalThis as unknown as {
      browser?: {
        sidebarAction?: { open: () => Promise<void> };
        sidePanel?: { open: (o: { windowId: number }) => Promise<void> };
      };
      chrome?: {
        sidebarAction?: { open: () => Promise<void> };
        sidePanel?: { open: (o: { windowId: number }) => Promise<void> };
      };
    };
    const api = g.browser ?? g.chrome;
    void api?.sidebarAction?.open?.().catch(() => {});
    const windowId = sender?.tab?.windowId;
    if (windowId != null) {
      void api?.sidePanel?.open?.({ windowId }).catch(() => {});
    }
  }

  private async dispatchPortDisconnect(invocationId: string) {
    const invo = await this.invocation(invocationId);
    if (!invo) return;
    await armWorker(invo.toolId)?.execute_abort?.(
      this.toolCtx(),
      invocationId,
    );
  }
}

function defaultBackendKind(): ActionLogBackendKind {
  // indexedDB shim sets this. unset means bun/node.
  return globalThis.areWeInTheBrowser === true ? "idb" : "sqlite";
}

async function openBackend(
  options: ActionLogOpenedCreateOptions,
): Promise<ActionLogBackend> {
  if (options.backendInstance) return options.backendInstance;
  const kind = options.backend ?? defaultBackendKind();
  if (kind === "idb") {
    const { ActionLogIdbBackend } = await import("./backend/idbBackend");
    const path = options.path ?? "actionlog";
    return ActionLogIdbBackend.open(path);
  }
  if (kind === "sqlite") {
    const { ActionLogSqliteBackend } = await import("./backend/sqliteBackend");
    const path = options.path ?? "actionlog.sqlite";
    return ActionLogSqliteBackend.open(path);
  }
  throw new Error(`unknown action log backend: ${kind}`);
}

export type {
  ActionLogBackend,
  ActionLogEvent,
  ActionLogEventType,
  ActionLogStage,
  InvocationDisplayStatus,
  InvocationState,
  ToolPermission,
  ToolWorkerContext,
} from "./actionLogTypes";
export { Invocation } from "./actionLogTypes";
export type { ToolNotice, ToolUiCopy } from "../tools/globals";
