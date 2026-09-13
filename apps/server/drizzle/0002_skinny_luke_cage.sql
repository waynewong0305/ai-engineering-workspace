CREATE TABLE `evidence_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`source_provider` text,
	`source_artifact_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `task_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_items_task_type_idx` ON `evidence_items` (`task_id`,`type`);--> statement-breakpoint
CREATE TABLE `task_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`target_provider` text,
	`structured_data` text,
	`raw_output` text NOT NULL,
	`parse_error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_artifacts_task_kind_idx` ON `task_artifacts` (`task_id`,`kind`);--> statement-breakpoint
CREATE TABLE `task_comparisons` (
	`task_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`problem_statement` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`risk_level` text NOT NULL,
	`web_access_policy` text NOT NULL,
	`web_access_permitted` integer NOT NULL,
	`web_access_decided_at` text NOT NULL,
	`web_access_decided_by` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_project_created_idx` ON `tasks` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `task_id` text REFERENCES tasks(id);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `role` text DEFAULT 'REPOSITORY_EXPLANATION' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `target_provider` text;--> statement-breakpoint
CREATE INDEX `agent_runs_task_created_idx` ON `agent_runs` (`task_id`,`created_at`);