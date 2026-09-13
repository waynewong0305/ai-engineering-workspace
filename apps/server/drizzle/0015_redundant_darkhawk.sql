CREATE TABLE `pricing_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_price_per_million` real NOT NULL,
	`cached_input_price_per_million` real,
	`cache_creation_input_price_per_million` real,
	`output_price_per_million` real NOT NULL,
	`reasoning_price_per_million` real,
	`effective_from` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_entries_provider_model_effective_idx` ON `pricing_entries` (`provider`,`model`,`effective_from`);--> statement-breakpoint
CREATE INDEX `pricing_entries_lookup_idx` ON `pricing_entries` (`provider`,`model`,`effective_from`);--> statement-breakpoint
ALTER TABLE `usage_records` ADD `actual_cost_usd` real;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `api_equivalent_cost_usd` real;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `pricing_entry_id` text REFERENCES pricing_entries(id);--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cost_source` text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cost_breakdown` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cost_calculated_at` text;