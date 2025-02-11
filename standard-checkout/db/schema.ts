import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const outputs = sqliteTable("outputs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  amount: integer("amount").notNull(),
  blockHeight: integer("block_height").notNull(),
  indexInTransaction: integer("index_in_transaction").notNull(),
  indexOnBlockchain: integer("index_on_blockchain").notNull(),
  paymentId: integer("payment_id").notNull(), // payment_id == checkout_session id
  stealthAddress: text("stealth_address").notNull().unique(),
  txHash: text("tx_hash").notNull(),
  timestamp: text("timestamp").default(sql`(CURRENT_TIMESTAMP)`),
});

export const checkoutSession = sqliteTable("checkout_session", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  amount: integer("amount").notNull(),
  sessionId: text("session_id").notNull(),
  address: text("address"),
  paidStatus: integer("paid_status", { mode: "boolean" })
    .notNull()
    .default(false),
  timestamp: text("timestamp").default(sql`(CURRENT_TIMESTAMP)`),
});

export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  height: integer("height").notNull(),
  timestamp: text("timestamp").default(sql`(CURRENT_TIMESTAMP)`),
});
