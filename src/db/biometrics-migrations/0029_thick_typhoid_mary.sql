CREATE TABLE `biometric_shadow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`plan_hash` text NOT NULL,
	`plan` text NOT NULL,
	`side` text NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	`lease_until_ms` integer,
	`heartbeat_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`reason` text,
	`point_count` integer DEFAULT 0 NOT NULL,
	`byte_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_shadow_runs_idempotency_key_unique` ON `biometric_shadow_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_biometric_shadow_side_state` ON `biometric_shadow_runs` (`side`,`state`);--> statement-breakpoint
CREATE TABLE `biometric_shadow_samples` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`byte_length` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `biometric_shadow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_shadow_sample` ON `biometric_shadow_samples` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_biometric_shadow_sample_time` ON `biometric_shadow_samples` (`run_id`,`timestamp_ms`);