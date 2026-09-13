ALTER TABLE `build_runs` ADD `merge_status` text DEFAULT 'NOT_MERGED' NOT NULL;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `merge_target_branch` text;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `merge_commit_sha` text;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `merged_at` text;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `merge_error` text;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `merge_target_checked_out_at` text;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `worktree_removed_after_merge` integer;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `branch_deleted_after_merge` integer;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `worktree_cleanup_skipped_reason` text;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `phase` text DEFAULT 'BUILD' NOT NULL;