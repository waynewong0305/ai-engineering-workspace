CREATE TABLE `adrs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`options_considered` text NOT NULL,
	`decision` text NOT NULL,
	`reasons` text NOT NULL,
	`consequences` text NOT NULL,
	`risks` text,
	`rejected_alternatives` text,
	`required_follow_up` text,
	`related_task_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adrs_project_number_idx` ON `adrs` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `adrs_task_idx` ON `adrs` (`task_id`);