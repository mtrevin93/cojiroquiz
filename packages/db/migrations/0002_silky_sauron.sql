ALTER TABLE `drafts` ADD `visual_json` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `text_key` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `picture_key` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `picture_phash` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `picture_description` text;--> statement-breakpoint
CREATE INDEX `questions_text_key_idx` ON `questions` (`text_key`);--> statement-breakpoint
UPDATE `questions` SET `text_key` = `dedupe_key` WHERE `text_key` IS NULL;
