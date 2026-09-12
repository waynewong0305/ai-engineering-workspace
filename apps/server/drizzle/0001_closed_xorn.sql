CREATE TABLE `agent_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_events_run_sequence_idx` ON `agent_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`prompt` text NOT NULL,
	`prompt_version` text NOT NULL,
	`requested_model` text NOT NULL,
	`actual_model` text,
	`effort` text,
	`permission_profile` text NOT NULL,
	`web_access_policy` text NOT NULL,
	`web_access_permitted` integer NOT NULL,
	`status` text NOT NULL,
	`output` text NOT NULL,
	`raw_output` text NOT NULL,
	`error_output` text NOT NULL,
	`error_message` text,
	`exit_code` integer,
	`cli_version` text,
	`duration_ms` integer,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_project_created_idx` ON `agent_runs` (`project_id`,`created_at`);