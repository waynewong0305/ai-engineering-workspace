CREATE TABLE `question_details` (
	`question_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`why_it_matters` text,
	`suggested_action` text,
	`expected_evidence` text,
	`suggestion_source` text,
	`duplicate_of_question_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `evidence_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`duplicate_of_question_id`) REFERENCES `evidence_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `question_details_task_status_idx` ON `question_details` (`task_id`,`status`);--> statement-breakpoint
CREATE TABLE `question_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`task_id` text NOT NULL,
	`answer` text NOT NULL,
	`resulting_status` text NOT NULL,
	`linked_evidence_item_id` text,
	`linked_experiment_id` text,
	`source` text DEFAULT 'HUMAN' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `evidence_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_evidence_item_id`) REFERENCES `evidence_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`linked_experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `question_responses_question_created_idx` ON `question_responses` (`question_id`,`created_at`);--> statement-breakpoint
-- Hand-added data backfill (not drizzle-kit generated): every pre-existing QUESTION evidence item
-- gets an OPEN question_details row with no invented suggestion content, so
-- "every QUESTION evidence item has exactly one question_details row" holds for data that predates
-- this migration too. Question text in evidence_items is never touched.
INSERT INTO `question_details` (`question_id`, `task_id`, `status`, `created_at`, `updated_at`)
SELECT `id`, `task_id`, 'OPEN', `created_at`, `updated_at` FROM `evidence_items` WHERE `type` = 'QUESTION';