CREATE TABLE `provider_usage_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`window_id` text NOT NULL,
	`window_label` text NOT NULL,
	`window_duration_ms` integer,
	`used_percent` real NOT NULL,
	`reset_at` text,
	`source` text NOT NULL,
	`source_confidence` text NOT NULL,
	`recorded_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_usage_readings_provider_window_idx` ON `provider_usage_readings` (`provider`,`window_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_safety_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`window_id` text,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`related_reading_id` text,
	`user_action` text,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`related_reading_id`) REFERENCES `provider_usage_readings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_safety_audit_provider_created_idx` ON `usage_safety_audit` (`provider`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_safety_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`warning_threshold_percent` real NOT NULL,
	`checkpoint_threshold_percent` real NOT NULL,
	`stale_after_ms` integer NOT NULL,
	`acknowledgement_ttl_ms` integer NOT NULL,
	`updated_at` text NOT NULL
);
