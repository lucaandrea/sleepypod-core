CREATE TABLE `biometric_backtest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`input` text NOT NULL,
	`state` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at_ms` integer,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`heartbeat_at_ms` integer,
	`progress` text NOT NULL,
	`cancellation_requested_at_ms` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `biometric_experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_backtest_jobs_idempotency_key_unique` ON `biometric_backtest_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_biometric_job_state_created` ON `biometric_backtest_jobs` (`state`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_biometric_job_experiment` ON `biometric_backtest_jobs` (`experiment_id`);--> statement-breakpoint
CREATE TABLE `biometric_backtest_results` (
	`job_id` text PRIMARY KEY NOT NULL,
	`fencing_token` integer NOT NULL,
	`report` text NOT NULL,
	`content_hash` text NOT NULL,
	`completed_at_ms` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `biometric_backtest_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `biometric_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`side` text NOT NULL,
	`protocol` text NOT NULL,
	`protocol_hash` text NOT NULL,
	`holdout_accesses` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `biometric_datasets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_biometric_experiment_dataset` ON `biometric_experiments` (`dataset_id`);