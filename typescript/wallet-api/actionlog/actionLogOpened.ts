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
  getExtensionBrowser,
  getExtensionRuntime,
  type ExtensionMessageByKind,
  type ExtensionMessageKind,
  type ExtensionPort,
  type ToolNotice,
} from "../tools/globals";
import { restoreCacheAmounts } from "../send-functionality/conversion";
import type { CoordinatorResults } from "../scanning-syncing/scanresult/coordinatorCommand";
import type { ManyScanCachesOpened } from "../scanning-syncing/scanresult/scanCacheOpened";
import { ActionLogIdbBackend } from "./backend/idbBackend";
import { ActionLogSqliteBackend } from "./backend/sqliteBackend";

export type ActionLogBackendKind = "sqlite" | "idb";
export type ExtensionMessageBus = "background" | "ui";

export type ActionLogOpenedCreateOptions = {
  path?: string;
  backend?: ActionLogBackendKind;
  backendInstance?: ActionLogBackend;
  onChange?: (() => void) | null;
  extensionMessageBus?: ExtensionMessageBus;
};

type BackgroundMessageResult =
  | { ok: true; result?: unknown }
  | { events?: ActionLogEvent[] }
  | { tx_logs: unknown }
  | void;

type ExtensionMessageSender = { url?: string; tab?: { windowId?: number } };
type SidebarMetadata = NonNullable<ExtensionMessageByKind["openSidebar"]>["metadata"];
type ReceiveSidebarMetadata = (metadata: SidebarMetadata) => void | Promise<void>;

function armWorker(toolId: ToolId) {
  return tools[toolId]?.worker;
}

/**
 * records tool invocations and their results. openWallets() returns a ManyScanCachesOpened
 * that exposes the shared log as actionLogOpened. the log can access each ScanCacheOpened
 * through the ManyScanCachesOpened.wallets list.
 * use toolCall() to record a request, execute() to accept it, or dismiss() to decline it.
 *
 * in an extension, the background page runs the scanner and writes the log.
 * callExtensionBackground() sends a request from a ui page and waits for the reply.
 * callExtensionSidebar() sends log, wallet list and cache updates to the ui pages.
 *
 * outside an extension, callers use the log directly. it uses SQLite by default.
 */
export class ActionLogOpened {
  private ports = new Map<string, ExtensionPort>();
  private runtimeInstalled = false;
  private bus: ExtensionMessageBus | null = null;
  private mco: ManyScanCachesOpened | null = null;
  private reloadWallets?: (scan_settings_path?: string) => Promise<void>;
  private uiMessages: Promise<void> = Promise.resolve();
  private sidebarWatcher?: { windowId: number; receive: ReceiveSidebarMetadata };
  private pendingSidebarMetadata = new Map<number, SidebarMetadata>();
  private sidebarOpenRequest = 0;
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
  bindMco(
    mco: ManyScanCachesOpened,
    reloadWallets?: (scan_settings_path?: string) => Promise<void>,
  ): Promise<void> {
    this.mco = mco;
    this.reloadWallets = reloadWallets;
    if (this.bus !== "ui" || !reloadWallets) return Promise.resolve();
    const ready = this.uiMessages.then(() => reloadWallets());
    this.uiMessages = ready.then(() => {}, () => {});
    return ready;
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
    const isNew = !(await this.invocation(invo.invocation_id));
    if (isNew) {
      // a new call takes over its permission category. older active calls of the same permission are dismissed
      await this.dismissOthersOfSamePermission(invo);
      await w?.invoke_write?.(ctx, invo);
    }
    if (invo.valid !== "unverified") await w?.validate_write?.(ctx, invo);
  }

  /** only the newest active call per permission category stays open. */
  private async dismissOthersOfSamePermission(
    invo: ParsedMoneroToolInvocation,
  ) {
    const id = invo.tool.tool_id as ToolId;
    const perms = (tools[id]?.permissions as readonly string[]) ?? [];
    if (!perms.length) return;
    await this.refreshUiCache();
    const open = this.getActiveByPermissions(perms as ToolPermission[]);
    for (const row of open) {
      if (row.invocationId === invo.invocation_id) continue;
      await this.dismiss(row.invocationId);
    }
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
      await this.callExtensionBackground("dismissNotice", { noticeId }).catch(() => {});
      await this.refreshUiCache();
      return;
    }
    await this.dismissNoticeLocal(noticeId);
  }

  async dismiss(invocationId: string): Promise<void> {
    if (this.isUiBus()) {
      await this.callExtensionBackground("dismiss", { invocationId }).catch(() => {});
      return;
    }
    await this.dismissLocal(invocationId);
  }

  async execute(
    invocationId: string,
    args: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.isUiBus()) {
      await this.callExtensionBackground("execute", { invocationId, args }).catch(() => {});
      return;
    }
    await this.executeLocal(invocationId, args);
  }

  getPort(invocationId: string): ExtensionPort | undefined {
    return this.ports.get(invocationId);
  }
  // ---------- extension message bus ----------

  get extensionMessageBus(): ExtensionMessageBus | null {
    return this.bus;
  }

  private isUiBus(): boolean {
    return this.bus === "ui";
  }

  /**
   * sends a request from a ui page to the background page and waits for the reply.
   * returns the result or the raw reply. rejects on a missing or failed reply.
   */
  callExtensionBackground<K extends keyof ExtensionMessageByKind>(
    kind: K,
    payload: ExtensionMessageByKind[K],
  ): Promise<K extends `worker.${infer C extends keyof CoordinatorResults}` ? CoordinatorResults[C] : unknown>;
  async callExtensionBackground<K extends keyof ExtensionMessageByKind>(
    kind: K,
    payload: ExtensionMessageByKind[K],
  ): Promise<unknown> {
    const reply = await getExtensionRuntime()?.sendMessage({ kind, payload });
    if (!reply || typeof reply !== "object")
      throw new Error(`no reply from the extension bus for ${kind}`);
    if ("error" in reply) throw new Error(String(reply.error));
    if ("ok" in reply) {
      if (reply.ok !== true) throw new Error(`the extension bus rejected ${kind}`);
      return "result" in reply ? reply.result : undefined;
    }
    return reply;
  }

  /** opens the native sidebar for this extension tab and passes app context to it. */
  async openSidebar(options: { metadata: SidebarMetadata }): Promise<void> {
    const request = ++this.sidebarOpenRequest;
    const api = getExtensionBrowser();
    let windowId: number | undefined;
    if (api?.sidebarAction) {
      await api.sidebarAction.open();
    } else if (api?.sidePanel) {
      windowId = (await api.windows?.getCurrent())?.id;
      if (windowId == null) throw new Error("no extension sidebar window");
      await api.sidePanel.open({ windowId });
    } else {
      throw new Error("native sidebar unavailable");
    }
    if (request === this.sidebarOpenRequest) await this.callExtensionBackground("openSidebar", { ...options, windowId });
  }

  /** use in the sidebar to receive pending and later metadata for its browser window. */
  async watchSidebarMetadata(receive: ReceiveSidebarMetadata): Promise<void> {
    const windowId = (await getExtensionBrowser()?.windows?.getCurrent())?.id;
    if (windowId == null) throw new Error("no extension sidebar window");
    const watcher = { windowId, receive };
    this.sidebarWatcher = watcher;
    await this.takeSidebarMetadata(watcher);
  }

  private async takeSidebarMetadata(watcher: { windowId: number; receive: ReceiveSidebarMetadata }) {
    const metadata = await this.callExtensionBackground("takeSidebarMetadata", { windowId: watcher.windowId });
    if (metadata != null && watcher === this.sidebarWatcher) await watcher.receive(metadata as SidebarMetadata);
  }

  /** sends an update from the background page to the ui pages without waiting for a reply. */
  callExtensionSidebar<K extends keyof ExtensionMessageByKind>(
    kind: K,
    payload: ExtensionMessageByKind[K],
  ): void {
    getExtensionRuntime()?.sendMessage({ kind, payload }).catch(() => {});
  }

  private broadcastActionLogChanged() {
    this.callExtensionSidebar("actionLogChanged", null);
  }

  // distinguish message handling by bus type 
  private handlesMessage(kind: string): boolean {
    if (this.bus === "ui") {
      if (kind === "sidebarMetadataChanged") return !!this.sidebarWatcher;
      return ["actionLogChanged", "walletsChanged", "walletCacheChanged"].includes(kind);
    }
    if (this.bus !== "background") return false;
    return kind.startsWith("worker.") || [
      "openSidebar", "takeSidebarMetadata", "toolCall", "dismiss", "execute", "dismissNotice",
      "shareViewkeyOK", "shareViewkeyFAILED",
    ].includes(kind);
  }

  private listenOnMessage(
    handle: (
      env: { kind: ExtensionMessageKind; payload: unknown },
      sender?: ExtensionMessageSender,
    ) => Promise<BackgroundMessageResult>,
  ) {
    const rt = getExtensionRuntime();
    if (!rt) return;
    rt.onMessage.addListener((msg, sender: unknown, sendResponse?: (r: unknown) => void) => {
      const kind = (msg as { kind?: string } | null)?.kind;
      if (!kind || !this.handlesMessage(kind)) return false;
      handle(
        msg as { kind: ExtensionMessageKind; payload: unknown },
        sender as ExtensionMessageSender | undefined,
      ).then(
        (result) => { if (result !== undefined) sendResponse?.(result); },
        (error) => sendResponse?.({ error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    });
  }

  installExtensionMessagebus() {
    if (this.runtimeInstalled) return;
    if (this.bus === "background") this.installBackgroundMessagebus();
    else if (this.bus === "ui") this.installUiMessagebus();
  }

  private installUiMessagebus() {
    this.runtimeInstalled = true;
    this.listenOnMessage((env) => {
      const next = this.uiMessages.then(() => this.handleUiMessage(env));
      this.uiMessages = next.then(() => {}, () => {});
      return next;
    });
  }

  private installBackgroundMessagebus() {
    const rt = getExtensionRuntime();
    if (!rt) return;
    this.runtimeInstalled = true;
    this.listenOnMessage((env, sender) => this.handleBackgroundMessage(env, sender));
    rt.onConnect.addListener((port) => {
      const invocationId = port.name;
      const existing = this.ports.get(invocationId);
      if (existing) existing.disconnect();
      this.ports.set(invocationId, port);
      port.onDisconnect.addListener(() => {
        if (this.ports.get(invocationId) !== port) return;
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
    if (env.kind === "walletsChanged") {
      const payload = env.payload as ExtensionMessageByKind["walletsChanged"];
      if (payload?.scan_settings_path) await this.reloadWallets?.(payload.scan_settings_path);
      return {};
    }
    if (env.kind === "walletCacheChanged") {
      const raw = typeof env.payload === "string" ? JSON.parse(env.payload) : env.payload;
      if (typeof env.payload === "string") restoreCacheAmounts(raw);
      await this.mco?.feed(raw);
      return {};
    }
    if (env.kind === "sidebarMetadataChanged") {
      const watcher = this.sidebarWatcher;
      const payload = env.payload as ExtensionMessageByKind["sidebarMetadataChanged"] | null;
      if (watcher && payload?.windowId === watcher.windowId) await this.takeSidebarMetadata(watcher);
      return {};
    }
    // Unhandled kinds (worker.* queries especially) get no answer here.
    // The worker answers, and the first answer wins. A local {} would win
    // the race and hide the worker response.
    return;
  }

  private requireWallets(): ManyScanCachesOpened {
    if (!this.mco) throw new Error("background wallet is not ready");
    return this.mco;
  }

  private async handleBackgroundMessage(
    env: { kind: ExtensionMessageKind; payload: unknown },
    sender?: ExtensionMessageSender,
  ): Promise<BackgroundMessageResult> {
    if (!env?.kind) return {};
    const ctx = this.toolCtx();
    switch (env.kind) {
      // native opening runs in the click; metadata stays on the existing command.
      case "openSidebar":
        if (env.payload != null) return this.handleSidebarMetadata(env.kind, env.payload, sender);
        this.openWalletUi(sender);
        return {};
      case "takeSidebarMetadata":
        return this.handleSidebarMetadata(env.kind, env.payload, sender);
      case "worker.setNodeUrl": {
        const p = env.payload as { node_url?: string };
        if (p?.node_url != null)
          await this.requireWallets().changeNodeUrl(p.node_url);
        return {};
      }
      case "worker.setStartHeight": {
        const p = env.payload as { start_height?: number | null };
        if (p && "start_height" in p)
          await this.requireWallets().changeStartHeight(p.start_height ?? null);
        return {};
      }
      case "worker.changeNodeUrlAndStartHeight": {
        const p = env.payload as {
          node_url?: string;
          start_height?: number | null;
        };
        await this.requireWallets().changeNodeUrlAndStartHeight(
          p?.node_url,
          p?.start_height,
        );
        return {};
      }
      case "worker.buildWallets":
        await this.requireWallets().buildWallets();
        return {};
      case "worker.stopWorker":
        await this.requireWallets().stopWorker();
        return {};
      case "worker.makeSignSend": {
        const p = env.payload as ExtensionMessageByKind["worker.makeSignSend"];
        const result = await this.requireWallets().makeSignSend(p);
        return { ok: true, result };
      }
      case "worker.sweepSignSend": {
        const p = env.payload as ExtensionMessageByKind["worker.sweepSignSend"];
        const result = await this.requireWallets().sweepSignSend(p);
        return { ok: true, result };
      }
      case "worker.releaseInputs": {
        await this.requireWallets().releaseInputs(env.payload as ExtensionMessageByKind["worker.releaseInputs"]);
        return { ok: true };
      }
      case "worker.rebroadcastTx": {
        const p = env.payload as ExtensionMessageByKind["worker.rebroadcastTx"];
        const result = await this.requireWallets().rebroadcastTx(p);
        return { ok: true, result };
      }
      case "worker.dismissSendPlate": {
        const p = env.payload as ExtensionMessageByKind["worker.dismissSendPlate"];
        await this.requireWallets().dismissSendPlate(p);
        return { ok: true };
      }
      case "worker.setLogSettings": {
        const p = env.payload as ExtensionMessageByKind["worker.setLogSettings"];
        await this.requireWallets().setLogSettings(
          p?.logs,
          p?.logs_include,
          p?.logs_exclude,
        );
        return {};
      }
      case "worker.getTxLogs": {
        const wallets = (
          this.mco as unknown as {
            wallets?: {
              primary_address: string;
              tx_logs: Record<string, unknown>[];
            }[];
          } | null
        )?.wallets;
        const rows = (wallets ?? []).map((w) => ({
          primary_address: w.primary_address,
          tx_logs: (w.tx_logs ?? []).map(
            (t: Record<string, unknown>, index: number) => {
              const out: Record<string, unknown> = { ...t, index };
              delete out.signed_tx;
              return out;
            },
          ),
        }));
        // chrome messages must be plain JSON. cache rows can hold bigints.
        const clean = JSON.parse(
          JSON.stringify(rows, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        );
        return { tx_logs: clean };
      }
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

  private handleSidebarMetadata(
    kind: "openSidebar" | "takeSidebarMetadata",
    payload: unknown,
    sender?: ExtensionMessageSender,
  ): BackgroundMessageResult {
    const extensionUrl = getExtensionRuntime()?.getURL("");
    if (!extensionUrl || !sender?.url?.startsWith(extensionUrl)) throw new Error("sidebar metadata requires an extension page");
    const request = payload as ExtensionMessageByKind["openSidebar"];
    const senderWindow = sender.tab?.windowId;
    const windowId = kind === "openSidebar" ? senderWindow : request?.windowId;
    if (windowId == null || !Number.isInteger(windowId) || windowId < 0) throw new Error("invalid sidebar window");
    if ((senderWindow != null && senderWindow !== windowId) || (request?.windowId != null && request.windowId !== windowId)) {
      throw new Error("sidebar request is from a different window");
    }
    if (kind === "takeSidebarMetadata") {
      const metadata = this.pendingSidebarMetadata.get(windowId);
      this.pendingSidebarMetadata.delete(windowId);
      return { ok: true, result: metadata ?? null };
    }
    const metadata = request?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid sidebar metadata");
    this.pendingSidebarMetadata.set(windowId, metadata);
    this.callExtensionSidebar("sidebarMetadataChanged", { windowId });
    return { ok: true };
  }

  private openWalletUi(sender?: ExtensionMessageSender) {
    const api = getExtensionBrowser();
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
    const path = options.path ?? "actionlog";
    return ActionLogIdbBackend.open(path);
  }
  if (kind === "sqlite") {
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
