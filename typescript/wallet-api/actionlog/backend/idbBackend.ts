import {
  ActiveInvocations,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
} from "../actionLogTypes";
import type { ToolId } from "../../tools/monero-tools";

const DB_NAME_DEFAULT = "actionlog";
const STORE_EVENTS = "events";

export class ActionLogIdbBackend implements ActionLogBackend {
  private active = new ActiveInvocations();

  private constructor(private readonly db: IDBDatabase) {}

  static async open(dbName = DB_NAME_DEFAULT): Promise<ActionLogIdbBackend> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB not available");
    }
    const db = await openDb(dbName);
    const backend = new ActionLogIdbBackend(db);
    await backend.rebuildActive();
    return backend;
  }

  private async rebuildActive() {
    this.active.clear();
    const events = await this.getAllEventsOrdered();
    for (const event of events) this.active.apply(event);
  }

  private getAllEventsOrdered(): Promise<ActionLogEvent[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_EVENTS, "readonly");
      const store = tx.objectStore(STORE_EVENTS);
      const req = store.getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const rows = (req.result as ActionLogEvent[]) ?? [];
        rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        resolve(rows);
      };
    });
  }

  async append(event: ActionLogEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE_EVENTS, "readwrite");
      const store = tx.objectStore(STORE_EVENTS);
      const req = store.put(event);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
    this.active.apply(event);
  }

  async getBranch(invocationId: string): Promise<ActionLogEvent[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_EVENTS, "readonly");
      const store = tx.objectStore(STORE_EVENTS);
      const index = store.index("invocationId");
      const req = index.getAll(invocationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const rows = (req.result as ActionLogEvent[]) ?? [];
        rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        resolve(rows);
      };
    });
  }

  async getTip(invocationId: string): Promise<ActionLogEvent | null> {
    const branch = await this.getBranch(invocationId);
    return branch.length ? branch[branch.length - 1]! : null;
  }

  async getActiveByToolId(toolId: ToolId): Promise<InvocationState | null> {
    return this.active.getActiveByToolId(toolId);
  }

  async getActiveInvocations(): Promise<InvocationState[]> {
    return this.active.getActiveInvocations();
  }

  async feed(events: ActionLogEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async reload(): Promise<void> {
    await this.rebuildActive();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const store = db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
        store.createIndex("invocationId", "invocationId", { unique: false });
        store.createIndex("toolId", "toolId", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}
