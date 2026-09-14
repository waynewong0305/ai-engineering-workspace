CREATE TABLE `task_usage_budgets` (
	`task_id` text PRIMARY KEY NOT NULL,
	`preset` text NOT NULL,
	`state` text NOT NULL,
	`max_tokens` integer,
	`api_equivalent_cost_warning_usd` real,
	`max_agent_runs` integer,
	`max_review_rounds` integer,
	`warning_percent` real NOT NULL,
	`continue_runs_remaining` integer DEFAULT 0 NOT NULL,
	`checkpoint_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_budget_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`event_type` text NOT NULL,
	`user_action` text,
	`reason` text NOT NULL,
	`budget_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_budget_audit_task_created_idx` ON `usage_budget_audit` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_cost_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`track_usage` integer NOT NULL,
	`show_api_equivalent_cost` integer NOT NULL,
	`store_raw_telemetry` integer NOT NULL,
	`default_budget_preset` text NOT NULL,
	`budget_presets` text NOT NULL,
	`updated_at` text NOT NULL
);
