import type { SQL } from "bun";
import {
  ActiveInvocations,
  Invocation,
  invocationStatus,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
  type InvocationStatus,
} from "../actionLogTypes";

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
      CREATE TABLE IF NOT EXISTS actionlog_invocations (
        invocationId TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        timestamp TEXT,
        toolId TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_actionlog_invo_status
      ON actionlog_invocations (status)
    `;
    const backend = new ActionLogSqliteBackend(sql);
    await backend.loadInvocations();
    return backend;
  }

  private async loadInvocations() {
    const rows = (await this.sql`
      SELECT body FROM actionlog_invocations
    `) as { body: string }[];
    if (!Array.isArray(rows) || !rows.length) {
      this.active.clear();
      return;
    }
    this.active.loadStates(
      rows.map((r) => JSON.parse(r.body) as InvocationState),
    );
  }

  /** body is the invocation as json. events[] is the state transitions. */
  private async upsertInvocation(state: InvocationState) {
    const body = JSON.stringify(state);
    const status = invocationStatus(state);
    await this.sql`
      INSERT INTO actionlog_invocations (invocationId, status, timestamp, toolId, body)
      VALUES (
        ${state.invocationId},
        ${status},
        ${state.timestamp ?? ""},
        ${state.toolId},
        ${body}
      )
      ON CONFLICT(invocationId) DO UPDATE SET
        status = ${status},
        timestamp = ${state.timestamp ?? ""},
        toolId = ${state.toolId},
        body = ${body}
    `;
  }

  async append(event: ActionLogEvent): Promise<void> {
    const next = this.active.apply(event);
    await this.upsertInvocation(next);
  }

  async invocation(invocationId: string): Promise<InvocationState | null> {
    const rows = (await this.sql`
      SELECT body FROM actionlog_invocations
      WHERE invocationId = ${invocationId}
    `) as { body: string }[];
    if (!Array.isArray(rows) || !rows[0]) return null;
    const s = JSON.parse(rows[0].body) as InvocationState;
    return new Invocation({ ...s, events: s.events ?? [] });
  }

  async invocations(status?: InvocationStatus): Promise<InvocationState[]> {
    const rows = (
      status
        ? await this.sql`
            SELECT body FROM actionlog_invocations
            WHERE status = ${status}
          `
        : await this.sql`SELECT body FROM actionlog_invocations`
    ) as { body: string }[];
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const s = JSON.parse(r.body) as InvocationState;
      return new Invocation({ ...s, events: s.events ?? [] });
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
