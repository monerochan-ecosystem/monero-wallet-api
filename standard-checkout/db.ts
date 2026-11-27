import { SQL } from "bun";
import type { TransactionTrackerState, TransactionStatus } from "@spirobel/monero-wallet-api";

const sql = new SQL({
  adapter: "sqlite",
  filename: Bun.env.CHECKOUT_DB || "monero_payments.db",
  create: true,
});
await sql`PRAGMA journal_mode = WAL`;
// concurrent checkout requests use the same database
await sql`PRAGMA busy_timeout = 5000`;

await sql`
CREATE TABLE IF NOT EXISTS checkout_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount TEXT NOT NULL,
    session_id TEXT NOT NULL,
    address TEXT,
    paid_status INTEGER NOT NULL DEFAULT 0,
    required_confirmations INTEGER NOT NULL DEFAULT 10,
    tx_confirmations INTEGER NOT NULL DEFAULT 0,
    tx_hash TEXT,
    tx_block_hash TEXT,
    tx_block_height INTEGER,
    tracker_state TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  );
`.execute();

const columns: { name: string }[] = await sql`SELECT name FROM pragma_table_info('checkout_session')`;
for (const [name, type] of [["tx_block_hash", "TEXT"], ["tx_block_height", "INTEGER"], ["tracker_state", "TEXT"]]) {
  if (!columns.some((column) => column.name === name)) {
    await sql.unsafe(`ALTER TABLE checkout_session ADD COLUMN ${name} ${type}`).execute();
  }
}

export type CheckoutSessionRow = {
  id: number;
  amount: string;
  session_id: string;
  address: string | null;
  paid_status: number;
  required_confirmations: number;
  tx_confirmations: number;
  tx_hash: string | null;
  tx_block_hash: string | null;
  tx_block_height: number | null;
  tracker_state: string | null;
  timestamp: string;
};

export function getCheckoutSessionByPrimaryId(
  id: number,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    SELECT * FROM checkout_session
    WHERE id = ${id}
  `.execute();
}
export function createCheckoutSession(
  amount: string,
  session_id: string,
  required_confirmations: number = 10,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    INSERT INTO checkout_session (amount, session_id, paid_status, required_confirmations)
    VALUES (${amount}, ${session_id}, 0, ${required_confirmations})
    RETURNING *
  `.execute();
}

export function updateCheckoutSessionAddress(
  session_id: string,
  address: string,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET address = ${address}
    WHERE session_id = ${session_id}
  `.execute();
}

export function updateCheckoutSessionPaid(
  session_id: string,
  paid_status: number,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET paid_status = ${paid_status}
    WHERE session_id = ${session_id}
  `.execute();
}

export function updateTxConfirmations(
  id: number,
  tx_confirmations: number,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET tx_confirmations = ${tx_confirmations}
    WHERE id = ${id}
  `.execute();
}

export function updateTxHash(
  id: number,
  tx_hash: string,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET tx_hash = ${tx_hash}
    WHERE id = ${id} AND (tx_hash IS NULL OR tx_hash = ${tx_hash})
    RETURNING *
  `.execute();
}

// only unpaid sessions with no confirmations can release their hash.
export function releaseTxHash(id: number, tx_hash: string): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET tx_hash = NULL
    WHERE id = ${id} AND tx_hash = ${tx_hash} AND tx_confirmations = 0 AND paid_status = 0
    RETURNING *
  `.execute();
}

export function getOpenTrackedSessions(): SQL.Query<(CheckoutSessionRow & { tracker_state: string })[]> {
  return sql`SELECT * FROM checkout_session WHERE paid_status = 0 AND tracker_state IS NOT NULL`.execute();
}

function writeCheckoutTrackers(states: readonly { id: number; data: TransactionTrackerState }[]): SQL.Query<CheckoutSessionRow[]> {
  const rows = states.map(({ id, data }) => ({
    id, data, paid: data.state === "confirmed" ? 1 : 0,
    block: data.state === "in_block" || data.state === "confirmed" ? data.position : undefined,
  }));
  // check all rows before changing any so concurrent requests cannot see a partial update.
  return sql`
    WITH updates AS MATERIALIZED (
      SELECT checkout_session.id, value
      FROM json_each(${JSON.stringify(rows)})
      JOIN checkout_session ON checkout_session.id = value ->> 'id'
      WHERE (paid_status = 0 OR value ->> 'paid' = 1)
        AND (tx_hash IS NULL OR tx_hash = value ->> '$.data.tx_hash')
    )
    UPDATE checkout_session
    SET tracker_state = value -> 'data', tx_hash = value ->> '$.data.tx_hash',
        tx_block_height = value ->> '$.block.height', tx_block_hash = value ->> '$.block.hash',
        tx_confirmations = value ->> '$.data.confirmations', paid_status = value ->> 'paid'
    FROM updates
    WHERE checkout_session.id = updates.id
      AND (SELECT COUNT(DISTINCT id) FROM updates) = ${rows.length}
    RETURNING *
  `.execute();
}

export function saveCheckoutTracker(id: number, data: TransactionTrackerState): SQL.Query<CheckoutSessionRow[]> {
  return writeCheckoutTrackers([{ id, data }]);
}

export async function saveCheckoutTrackers(states: readonly { id: number; data: TransactionTrackerState }[]): Promise<void> {
  if ((await writeCheckoutTrackers(states)).length !== states.length) throw new Error("checkout state was not saved");
}

// confirmations follow the chain. paid stays set once the required count is reached.
export function updateTransactionStatus(id: number, tx_hash: string, status: TransactionStatus | null): SQL.Query<CheckoutSessionRow[]> {
  const confirmations = status?.confirmations ?? 0;
  return sql`
    UPDATE checkout_session
    SET tx_confirmations = ${confirmations},
        tx_block_hash = ${status?.block_hash ?? null},
        tx_block_height = ${status?.block_height ?? null},
        paid_status = CASE WHEN ${status !== null} AND ${confirmations} >= required_confirmations THEN 1 ELSE paid_status END
    WHERE id = ${id} AND tx_hash = ${tx_hash}
    RETURNING *
  `.execute();
}

export function markAsPaid(id: number): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    UPDATE checkout_session
    SET paid_status = 1
    WHERE id = ${id}
  `.execute();
}
export function getCheckoutSessionBySessionId(
  session_id: string,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    SELECT * FROM checkout_session
    WHERE session_id = ${session_id}
  `.execute();
}

export function getCheckoutSessionByAddress(
  address: string,
): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    SELECT * FROM checkout_session
    WHERE address = ${address}
  `.execute();
}

export function getAllCheckoutSessions(): SQL.Query<CheckoutSessionRow[]> {
  return sql`
    SELECT * FROM checkout_session
    ORDER BY timestamp DESC
  `.execute();
}
