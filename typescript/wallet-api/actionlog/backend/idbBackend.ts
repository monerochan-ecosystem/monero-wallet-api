import {
  ActiveInvocations,
  Invocation,
  invocationStatus,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
  type InvocationStatus,
} from "../actionLogTypes";

const DB_NAME_DEFAULT = "actionlog";
const STORE_INVOCATIONS = "invocations";
const DB_VERSION = 1;

export class ActionLogIdbBackend implements ActionLogBackend {
  private active = new ActiveInvocations();

  private constructor(private readonly db: IDBDatabase) {}

  static async open(dbName = DB_NAME_DEFAULT): Promise<ActionLogIdbBackend> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB not available");
    }
    const db = await openDb(dbName);
    const backend = new ActionLogIdbBackend(db);
    await backend.loadInvocations();
    return backend;
  }

  private async loadInvocations() {
    const rows = await this.readInvocations();
    if (!rows.length) {
      this.active.clear();
      return;
    }
    this.active.loadStates(rows);
  }

  private readInvocations(): Promise<InvocationState[]> {
    return new Promise((resolve, reject) => {
      if (!this.db.objectStoreNames.contains(STORE_INVOCATIONS)) {
        resolve([]);
        return;
      }
      const tx = this.db.transaction(STORE_INVOCATIONS, "readonly");
      const req = tx.objectStore(STORE_INVOCATIONS).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        resolve((req.result as InvocationState[]) ?? []);
      };
    });
  }

  async append(event: ActionLogEvent): Promise<void> {
    const next = this.active.apply(event);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE_INVOCATIONS, "readwrite");
      tx.objectStore(STORE_INVOCATIONS).put({
        ...next,
        status: invocationStatus(next),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async invocation(invocationId: string): Promise<InvocationState | null> {
    return new Promise((resolve, reject) => {
      if (!this.db.objectStoreNames.contains(STORE_INVOCATIONS)) {
        resolve(this.active.invocation(invocationId));
        return;
      }
      const tx = this.db.transaction(STORE_INVOCATIONS, "readonly");
      const req = tx.objectStore(STORE_INVOCATIONS).get(invocationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const row = req.result as InvocationState | undefined;
        resolve(
          row ? new Invocation({ ...row, events: row.events ?? [] }) : null,
        );
      };
    });
  }

  async invocations(status?: InvocationStatus): Promise<InvocationState[]> {
    return new Promise((resolve, reject) => {
      if (!this.db.objectStoreNames.contains(STORE_INVOCATIONS)) {
        resolve(this.active.invocations(status));
        return;
      }
      const tx = this.db.transaction(STORE_INVOCATIONS, "readonly");
      const store = tx.objectStore(STORE_INVOCATIONS);
      const req = status
        ? store.index("status").getAll(status)
        : store.getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const rows = (req.result as InvocationState[]) ?? [];
        resolve(
          rows.map(
            (s) =>
              new Invocation({
                ...s,
                events: s.events ?? [],
              }),
          ),
        );
      };
    });
  }

  async feed(events: ActionLogEvent[]): Promise<void> {
    for (const event of events) {
      const invo = this.active.invocation(event.invocationId);
      if (invo?.events.some((e) => e.id === event.id)) continue;
      await this.append(event);
    }
  }

  async reload(): Promise<void> {
    await this.loadInvocations();
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_INVOCATIONS)) {
        const inv = db.createObjectStore(STORE_INVOCATIONS, {
          keyPath: "invocationId",
        });
        inv.createIndex("status", "status", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}
