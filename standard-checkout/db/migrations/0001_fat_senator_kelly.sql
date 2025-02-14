CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`height` integer NOT NULL,
	`timestamp` text DEFAULT (CURRENT_TIMESTAMP)
);
