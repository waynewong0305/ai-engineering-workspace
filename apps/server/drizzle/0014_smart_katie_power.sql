CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`role` text NOT NULL,
	`model_requested` text,
	`model_actual` text,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`cache_creation_tokens` integer,
	`output_tokens` integer,
	`reasoning_output_tokens` integer,
	`total_tokens` integer,
	`billing_mode` text DEFAULT 'unknown' NOT NULL,
	`usage_source` text NOT NULL,
	`raw_usage_metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_run_idx` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_records_project_created_idx` ON `usage_records` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_records_task_created_idx` ON `usage_records` (`task_id`,`created_at`);