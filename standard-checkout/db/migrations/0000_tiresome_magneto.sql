CREATE TABLE `checkout_session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`amount` integer NOT NULL,
	`session_id` text NOT NULL,
	`address` text,
	`paid_status` integer DEFAULT false NOT NULL,
	`timestamp` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `outputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`amount` integer NOT NULL,
	`block_height` integer NOT NULL,
	`index_in_transaction` integer NOT NULL,
	`index_on_blockchain` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`stealth_address` text NOT NULL,
	`tx_hash` text NOT NULL,
	`timestamp` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outputs_stealth_address_unique` ON `outputs` (`stealth_address`);