CREATE TABLE `biometric_holdout_accesses` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`side` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`accessed_at_ms` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `biometric_backtest_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_biometric_holdout_side_start` ON `biometric_holdout_accesses` (`side`,`start_ms`);