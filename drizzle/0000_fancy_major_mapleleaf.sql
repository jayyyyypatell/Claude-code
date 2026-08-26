CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_messages_conv_idx` ON `chat_messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `daily_metrics` (
	`date` text NOT NULL,
	`metric_type_id` integer NOT NULL,
	`value` real NOT NULL,
	`value_min` real,
	`value_max` real,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`grain_used` text DEFAULT 'sample' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`metric_type_id`) REFERENCES `metric_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_metrics_pk` ON `daily_metrics` (`date`,`metric_type_id`);--> statement-breakpoint
CREATE INDEX `daily_metrics_type_date_idx` ON `daily_metrics` (`metric_type_id`,`date`);--> statement-breakpoint
CREATE TABLE `habit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`habit_id` integer NOT NULL,
	`date` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `habit_entries_habit_date_uq` ON `habit_entries` (`habit_id`,`date`);--> statement-breakpoint
CREATE INDEX `habit_entries_date_idx` ON `habit_entries` (`date`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`emoji` text DEFAULT '✅' NOT NULL,
	`color` text DEFAULT 'indigo' NOT NULL,
	`schedule` text DEFAULT 'daily' NOT NULL,
	`days_mask` integer DEFAULT 127 NOT NULL,
	`target_per_day` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `habits_sort_idx` ON `habits` (`sort_order`);--> statement-breakpoint
CREATE TABLE `ingest_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`metrics_seen` integer DEFAULT 0 NOT NULL,
	`points_upserted` integer DEFAULT 0 NOT NULL,
	`sleep_upserted` integer DEFAULT 0 NOT NULL,
	`workouts_upserted` integer DEFAULT 0 NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`raw_path` text,
	`error` text,
	`warnings` text
);
--> statement-breakpoint
CREATE INDEX `ingest_log_received_idx` ON `ingest_log` (`received_at`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'weekly' NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`data` text,
	`model` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_kind_period_uq` ON `insights` (`kind`,`period_start`);--> statement-breakpoint
CREATE INDEX `insights_created_idx` ON `insights` (`created_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`mood` integer,
	`energy` integer,
	`tags` text,
	`is_private` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_date_uq` ON `journal_entries` (`date`);--> statement-breakpoint
CREATE TABLE `metric_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`metric_type_id` integer NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`grain` text DEFAULT 'sample' NOT NULL,
	`local_date` text NOT NULL,
	`tz_offset_minutes` integer DEFAULT 0 NOT NULL,
	`value` real NOT NULL,
	`value_min` real,
	`value_max` real,
	`value_2` real,
	`unit` text DEFAULT '' NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`metric_type_id`) REFERENCES `metric_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_points_natural_uq` ON `metric_points` (`metric_type_id`,`grain`,`start_at`,`source_name`);--> statement-breakpoint
CREATE INDEX `metric_points_type_time_idx` ON `metric_points` (`metric_type_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `metric_points_type_day_idx` ON `metric_points` (`metric_type_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `metric_points_day_idx` ON `metric_points` (`local_date`);--> statement-breakpoint
CREATE TABLE `metric_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`display_name` text NOT NULL,
	`canonical_unit` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`agg` text DEFAULT 'avg' NOT NULL,
	`source` text DEFAULT 'apple_health' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_types_key_uq` ON `metric_types` (`key`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sleep_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`total_sleep_min` real DEFAULT 0 NOT NULL,
	`asleep_min` real,
	`core_min` real,
	`deep_min` real,
	`rem_min` real,
	`awake_min` real,
	`in_bed_min` real,
	`efficiency` real,
	`source_name` text DEFAULT '' NOT NULL,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sleep_sessions_natural_uq` ON `sleep_sessions` (`date`,`source_name`);--> statement-breakpoint
CREATE INDEX `sleep_sessions_date_idx` ON `sleep_sessions` (`date`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`duration_sec` real DEFAULT 0 NOT NULL,
	`active_energy_kcal` real,
	`distance_m` real,
	`avg_heart_rate` real,
	`max_heart_rate` real,
	`route` text,
	`source_name` text DEFAULT '' NOT NULL,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workouts_date_idx` ON `workouts` (`date`);--> statement-breakpoint
CREATE INDEX `workouts_start_idx` ON `workouts` (`start_at`);