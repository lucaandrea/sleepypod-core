CREATE TABLE `package_exposures` (
	`attempt_id` text NOT NULL,
	`trial_id` text NOT NULL,
	`night_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`side` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`split` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `night_id`)
);
--> statement-breakpoint
CREATE INDEX `package_exposure_window` ON `package_exposures` (`subject_id`,`side`,`start_ms`,`end_ms`);--> statement-breakpoint
CREATE TABLE `package_studies` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_studies_hash_unique` ON `package_studies` (`hash`);--> statement-breakpoint
CREATE TABLE `package_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	`lease_until` integer,
	`report_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_trials_idempotency_key_unique` ON `package_trials` (`idempotency_key`);