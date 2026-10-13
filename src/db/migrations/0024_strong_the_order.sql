CREATE TABLE `biometric_activation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`generation` integer NOT NULL,
	`action` text NOT NULL,
	`previous_revision_id` text,
	`next_revision_id` text,
	`previous_hash` text NOT NULL,
	`next_hash` text NOT NULL,
	`evaluation_id` text,
	`evidence` text NOT NULL,
	`requester` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_activation_generation` ON `biometric_activation_events` (`side`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_activation_idempotency` ON `biometric_activation_events` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `biometric_config_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`generation` integer NOT NULL,
	`payload` text NOT NULL,
	`resolved_hash` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at_ms` integer NOT NULL,
	`last_error` text,
	`created_at_ms` integer NOT NULL,
	`delivered_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_outbox_generation` ON `biometric_config_outbox` (`side`,`generation`);--> statement-breakpoint
CREATE INDEX `idx_biometric_outbox_pending` ON `biometric_config_outbox` (`state`,`next_attempt_at_ms`);--> statement-breakpoint
CREATE TABLE `biometric_profile_bindings` (
	`side` text PRIMARY KEY NOT NULL,
	`desired_revision_id` text,
	`generation` integer NOT NULL,
	`previous_revision_id` text,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `biometric_profile_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`revision` integer NOT NULL,
	`side` text NOT NULL,
	`base_manifest_hash` text NOT NULL,
	`base_manifest` text NOT NULL,
	`overrides` text NOT NULL,
	`resolved` text NOT NULL,
	`resolved_hash` text NOT NULL,
	`dependency_hashes` text NOT NULL,
	`parent_revision_id` text,
	`origin` text NOT NULL,
	`requester` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_profile_family_revision` ON `biometric_profile_revisions` (`family_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_biometric_profile_idempotency` ON `biometric_profile_revisions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_biometric_profile_side_created` ON `biometric_profile_revisions` (`side`,`created_at_ms`);