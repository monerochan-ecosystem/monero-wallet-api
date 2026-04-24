import { SQL } from "bun";

const sql = new SQL({
  adapter: "sqlite",
  filename: "monero_payments.db",
  create: true,
});

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
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  );
`.execute();

export type CheckoutSessionRow = {
  id: number;
  amount: string;
  session_id: string;
  address: string | null;
  paid_status: number;
  required_confirmations: number;
  tx_confirmations: number;
  tx_hash: string | null;
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
    WHERE id = ${id}
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
