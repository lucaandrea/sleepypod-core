CREATE TABLE `biometric_dataset_raw_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`position` integer NOT NULL,
	`released_at_ms` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `biometric_datasets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_hash`) REFERENCES `biometric_raw_artifacts`(`content_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_biometric_dataset_raw_identity` ON `biometric_dataset_raw_artifacts` (`dataset_id`,`artifact_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_biometric_dataset_raw_position` ON `biometric_dataset_raw_artifacts` (`dataset_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_biometric_raw_artifact_references` ON `biometric_dataset_raw_artifacts` (`artifact_hash`,`released_at_ms`);--> statement-breakpoint
CREATE TABLE `biometric_raw_artifacts` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`compressed_bytes` integer NOT NULL,
	`expanded_bytes` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`released_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_raw_artifacts_name_unique` ON `biometric_raw_artifacts` (`name`);--> statement-breakpoint
CREATE TABLE `biometric_raw_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`source_name` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`descriptor` text NOT NULL,
	`inventory_version` text NOT NULL,
	`inventory` text NOT NULL,
	`first_event_ms` integer,
	`last_event_ms` integer,
	`inspected_at_ms` integer NOT NULL,
	`unavailable_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_biometric_raw_source_identity` ON `biometric_raw_sources` (`source_name`,`artifact_hash`,`inventory_version`);--> statement-breakpoint
CREATE INDEX `idx_biometric_raw_source_window` ON `biometric_raw_sources` (`first_event_ms`,`last_event_ms`);