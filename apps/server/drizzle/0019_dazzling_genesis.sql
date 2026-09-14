PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-fixed (not drizzle-kit generated as-is): the OLD task_comparisons table has no `id` or
-- `version` columns at all (it was `task_id primaryKey`, one row per task) — drizzle-kit's naive
-- column-name copy would reference columns that don't exist and fail. Every pre-existing row
-- becomes version 1 (the only version that existed before this migration); `id` is backfilled with
-- a random hex id (SQLite has no UUID function) since nothing in this app parses id format, only
-- treats it as an opaque unique key — new rows going forward get a real randomUUID() from Node as
-- usual.
INSERT INTO `__new_task_comparisons`("id", "task_id", "version", "content", "generated_at")
SELECT lower(hex(randomblob(16))), "task_id", 1, "content", "generated_at" FROM `task_comparisons`;--> statement-breakpoint
DROP TABLE `task_comparisons`;--> statement-breakpoint
ALTER TABLE `__new_task_comparisons` RENAME TO `task_comparisons`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `task_comparisons_task_version_idx` ON `task_comparisons` (`task_id`,`version`);--> statement-breakpoint
CREATE INDEX `task_comparisons_task_idx` ON `task_comparisons` (`task_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `plan_revision_round` integer DEFAULT 1 NOT NULL;