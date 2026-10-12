CREATE TABLE `biometric_processing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`bundle` text NOT NULL,
	`config_hash` text NOT NULL,
	`calibration_hash` text,
	`input_identity` text NOT NULL,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_biometric_processing_side_start` ON `biometric_processing_runs` (`side`,`started_at_ms`);--> statement-breakpoint
CREATE TABLE `biometric_runtime_configs` (
	`side` text NOT NULL,
	`generation` integer NOT NULL,
	`resolved_hash` text NOT NULL,
	`payload` text NOT NULL,
	`boundary` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_runtime_config` ON `biometric_runtime_configs` (`side`,`generation`);--> statement-breakpoint
CREATE TABLE `biometric_runtime_receipts` (
	`side` text NOT NULL,
	`component` text NOT NULL,
	`generation` integer NOT NULL,
	`applied_hash` text NOT NULL,
	`effective_sample_time_ms` integer,
	`state` text NOT NULL,
	`error` text,
	`heartbeat_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_runtime_receipt` ON `biometric_runtime_receipts` (`side`,`component`,`generation`);--> statement-breakpoint
ALTER TABLE `vitals` ADD `processing_run_id` text;