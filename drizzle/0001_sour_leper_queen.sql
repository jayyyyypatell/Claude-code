ALTER TABLE `ingest_log` ADD `body_hash` text;--> statement-breakpoint
CREATE INDEX `ingest_log_hash_idx` ON `ingest_log` (`body_hash`,`received_at`);