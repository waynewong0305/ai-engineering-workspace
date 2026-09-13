ALTER TABLE `build_runs` ADD `review_round` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `build_runs` ADD `max_review_rounds` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `round` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `builder_verdict` text;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `builder_evidence` text;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `builder_action` text;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `responded_at` text;--> statement-breakpoint
ALTER TABLE `review_findings` ADD `reviewer_recheck_note` text;