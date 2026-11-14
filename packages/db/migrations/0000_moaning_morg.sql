CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` integer NOT NULL,
	`parsed_json` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message` text NOT NULL,
	`contact` text,
	`ip_hash` text NOT NULL,
	`emailed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha256` text NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`has_reveal` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_sha256_uq` ON `images` (`sha256`);--> statement-breakpoint
CREATE TABLE `quarantine` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha256` text NOT NULL,
	`key` text NOT NULL,
	`reason` text NOT NULL,
	`parsed_json` text,
	`ip_hash` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`fixture` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `quarantine_status_idx` ON `quarantine` (`status`);--> statement-breakpoint
CREATE INDEX `quarantine_sha_idx` ON `quarantine` (`sha256`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`lang` text NOT NULL,
	`level` text,
	`question_text` text NOT NULL,
	`search_text` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`choices_json` text NOT NULL,
	`answer_index` integer NOT NULL,
	`answer_source` text NOT NULL,
	`question_image_id` integer,
	`answer_image_id` integer,
	`submission_count` integer DEFAULT 1 NOT NULL,
	`disputed` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`question_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answer_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_slug_uq` ON `questions` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `questions_dedupe_uq` ON `questions` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `questions_lang_idx` ON `questions` (`lang`);--> statement-breakpoint
CREATE INDEX `questions_level_idx` ON `questions` (`level`);--> statement-breakpoint
CREATE TABLE `rate_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_kind_ip_idx` ON `rate_events` (`kind`,`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`ip_hash` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_question_idx` ON `reports` (`question_id`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`image_id` integer,
	`parsed_json` text,
	`answer_canonical` text NOT NULL,
	`answer_source` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submissions_question_idx` ON `submissions` (`question_id`);