-- Custom SQL migration file, put your code below! --
-- Pre-existing bug fix (discovered while building Phase 5's build/review workflow, not a Phase 5
-- feature itself): migrations 0002/0003 added `agent_runs.task_id`/`agent_runs.worktree_id` via
-- `ALTER TABLE ... ADD COLUMN ... REFERENCES ...`, which SQLite always creates with an implicit
-- `ON DELETE NO ACTION`, regardless of the `onDelete: "cascade"`/`onDelete: "set null"` already
-- declared in schema.ts at the time. This was invisible until something tried to delete a worktree
-- or task while agent_runs rows referencing it still needed to survive (every prior code path only
-- ever deleted the whole project, which cascades through `agent_runs.project_id` directly and never
-- exercises this path). Rebuilds the table with the FK actions schema.ts already declared; no data
-- is lost, just foreign_keys defaults for TWO ALTER-added columns being fixed to match intent.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`worktree_id` text,
	`provider` text NOT NULL,
	`role` text DEFAULT 'REPOSITORY_EXPLANATION' NOT NULL,
	`target_provider` text,
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_agent_runs` (
	`id`, `project_id`, `task_id`, `worktree_id`, `provider`, `role`, `target_provider`, `prompt`,
	`prompt_version`, `requested_model`, `actual_model`, `effort`, `permission_profile`,
	`web_access_policy`, `web_access_permitted`, `status`, `output`, `raw_output`, `error_output`,
	`error_message`, `exit_code`, `cli_version`, `duration_ms`, `started_at`, `completed_at`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `project_id`, `task_id`, `worktree_id`, `provider`, `role`, `target_provider`, `prompt`,
	`prompt_version`, `requested_model`, `actual_model`, `effort`, `permission_profile`,
	`web_access_policy`, `web_access_permitted`, `status`, `output`, `raw_output`, `error_output`,
	`error_message`, `exit_code`, `cli_version`, `duration_ms`, `started_at`, `completed_at`,
	`created_at`, `updated_at`
FROM `agent_runs`;--> statement-breakpoint
DROP TABLE `agent_runs`;--> statement-breakpoint
ALTER TABLE `__new_agent_runs` RENAME TO `agent_runs`;--> statement-breakpoint
CREATE INDEX `agent_runs_project_created_idx` ON `agent_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_task_created_idx` ON `agent_runs` (`task_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
