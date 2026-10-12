CREATE TABLE `biometric_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`subject_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`snapshot` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_datasets_idempotency_key_unique` ON `biometric_datasets` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_biometric_dataset_side_created` ON `biometric_datasets` (`side`,`created_at_ms`,`id`);