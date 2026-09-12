CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`current_branch` text NOT NULL,
	`worktree_root` text NOT NULL,
	`project_context` text,
	`validation_commands` text NOT NULL,
	`git_status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_path_unique` ON `projects` (`repository_path`);