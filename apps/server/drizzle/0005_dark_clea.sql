CREATE TABLE `build_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`builder_provider` text NOT NULL,
	`reviewer_provider` text NOT NULL,
	`worktree_id` text,
	`builder_run_id` text,
	`reviewer_run_id` text,
	`status` text NOT NULL,
	`diff_unstaged` text,
	`diff_staged` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`builder_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewer_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `build_runs_task_created_idx` ON `build_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`build_run_id` text NOT NULL,
	`reviewer_run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`file` text,
	`start_line` integer,
	`end_line` integer,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`evidence` text NOT NULL,
	`impact` text NOT NULL,
	`suggested_fix` text,
	`suggested_test` text,
	`confidence` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`build_run_id`) REFERENCES `build_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_findings_build_idx` ON `review_findings` (`build_run_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `validation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`build_run_id` text NOT NULL,
	`worktree_id` text,
	`command_id` text NOT NULL,
	`command_label` text NOT NULL,
	`command` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`exit_code` integer,
	`stdout` text NOT NULL,
	`stderr` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`build_run_id`) REFERENCES `build_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `validation_runs_build_created_idx` ON `validation_runs` (`build_run_id`,`created_at`);