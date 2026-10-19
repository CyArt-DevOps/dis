-- Former interns stay on record (profiles, reports) but drop out of stats.
ALTER TABLE `Member`
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    ADD COLUMN `formerAt` DATETIME(3) NULL,
    ADD COLUMN `formerReason` TEXT NULL;
