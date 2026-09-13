CREATE TABLE `frontend_review_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`agent_configuration` text NOT NULL,
	`reason` text NOT NULL,
	`scope` text NOT NULL,
	`trigger_description` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`decided_at` text,
	`consumed_at` text,
	`consumed_by_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `frontend_review_approvals_task_idx` ON `frontend_review_approvals` (`task_id`,`created_at`);