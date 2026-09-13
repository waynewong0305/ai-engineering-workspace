CREATE TABLE `worktree_usages` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worktree_usages_active_idx` ON `worktree_usages` (`worktree_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`path` text NOT NULL,
	`branch_name` text NOT NULL,
	`base_ref` text NOT NULL,
	`status` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_task_provider_idx` ON `worktrees` (`task_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_project_branch_idx` ON `worktrees` (`project_id`,`branch_name`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `worktree_id` text REFERENCES worktrees(id);