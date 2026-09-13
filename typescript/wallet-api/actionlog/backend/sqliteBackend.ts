import type { SQL } from "bun";
import {
  ActiveInvocations,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
} from "../actionLogTypes";
import type { ToolId } from "../../tools/monero-tools";

export class ActionLogSqliteBackend implements ActionLogBackend {
  private active = new ActiveInvocations();
  private sql: SQL;

  private constructor(sql: SQL) {
    this.sql = sql;
  }

  static async open(filename: string): Promise<ActionLogSqliteBackend> {
    // specifier is not a literal so browser bun build does not fail on builtin bun
    const spec = "bun";
    const { SQL: SqlCtor } = (await import(spec)) as { SQL: typeof SQL };
    const sql = new SqlCtor({
      adapter: "sqlite",
      filename,
      create: true,
    });
    await sql`PRAGMA journal_mode = WAL`;
    await sql`
      CREATE TABLE IF NOT EXISTS actionlog_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        invocationId TEXT NOT NULL,
        stage TEXT NOT NULL,
        type TEXT NOT NULL,
        toolId TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_actionlog_invocation
      ON actionlog_events (invocationId)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_actionlog_tool
      ON actionlog_events (toolId)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_actionlog_invocation_ts
      ON actionlog_events (invocationId, timestamp)
    `;
    const backend = new ActionLogSqliteBackend(sql);
    await backend.rebuildActive();
    return backend;
  }

  private async rebuildActive() {
    this.active.clear();
    const rows = (await this.sql`
      SELECT body FROM actionlog_events ORDER BY rowid ASC
    `) as { body: string }[];
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      this.active.apply(JSON.parse(row.body) as ActionLogEvent);
    }
  }

  async append(event: ActionLogEvent): Promise<void> {
    const body = JSON.stringify(event);
    await this.sql`
      INSERT INTO actionlog_events (id, timestamp, invocationId, stage, type, toolId, body)
      VALUES (
        ${event.id},
        ${event.timestamp},
        ${event.invocationId},
        ${event.stage},
        ${event.type},
        ${event.toolId},
        ${body}
      )
    `;
    this.active.apply(event);
  }

  async getBranch(invocationId: string): Promise<ActionLogEvent[]> {
    const rows = (await this.sql`
      SELECT body FROM actionlog_events
      WHERE invocationId = ${invocationId}
      ORDER BY rowid ASC
    `) as { body: string }[];
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => JSON.parse(r.body) as ActionLogEvent);
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
    for (const event of events) {
      try {
        await this.append(event);
      } catch {
        // skip duplicate
      }
    }
  }

  async reload(): Promise<void> {
    await this.rebuildActive();
  }
}
