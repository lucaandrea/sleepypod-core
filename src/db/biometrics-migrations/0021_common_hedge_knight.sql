CREATE TABLE `reference_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`revision` integer NOT NULL,
	`supersedes_import_id` text,
	`content_hash` text NOT NULL,
	`source` text NOT NULL,
	`adapter_version` text NOT NULL,
	`side` text NOT NULL,
	`subject_id` text NOT NULL,
	`time_policy` text NOT NULL,
	`summary` text NOT NULL,
	`overlap_policy` text DEFAULT 'exclude_conflicts' NOT NULL,
	`accepted_count` integer NOT NULL,
	`rejected_count` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`deleted_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_import_active_root` ON `reference_imports` (`content_hash`) WHERE "reference_imports"."deleted_at_ms" IS NULL AND "reference_imports"."supersedes_import_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_import_active_correction` ON `reference_imports` (`content_hash`,`supersedes_import_id`) WHERE "reference_imports"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_import_revision` ON `reference_imports` (`family_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_reference_import_side_created` ON `reference_imports` (`side`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE TABLE `reference_measurements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` text NOT NULL,
	`record_key` text NOT NULL,
	`side` text NOT NULL,
	`metric` text NOT NULL,
	`value` real,
	`stage` text,
	`unit` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`temporal_kind` text NOT NULL,
	`aggregation` text NOT NULL,
	`window_ms` integer,
	`quality` real,
	`scorable` integer NOT NULL,
	`exclusions` text NOT NULL,
	`original` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `reference_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_measurement_key` ON `reference_measurements` (`import_id`,`record_key`);--> statement-breakpoint
CREATE INDEX `idx_reference_measurement_side_metric_start` ON `reference_measurements` (`side`,`metric`,`start_ms`);--> statement-breakpoint
CREATE INDEX `idx_reference_measurement_import_id` ON `reference_measurements` (`import_id`,`id`);--> statement-breakpoint
ALTER TABLE `reference_stages` ADD `import_id` text;--> statement-breakpoint
ALTER TABLE `reference_vitals` ADD `import_id` text;