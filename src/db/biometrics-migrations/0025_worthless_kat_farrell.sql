ALTER TABLE `biometric_experiments` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `biometric_experiments` ADD `request_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_experiments_idempotency_key_unique` ON `biometric_experiments` (`idempotency_key`);