-- Half-day leave (EMS spec 2026-11-07 §7): a leave can cover a 3 h window ("HH:MM" IST) of one day instead of the whole day.
-- AlterTable
ALTER TABLE `LeaveRequest` ADD COLUMN `halfDay` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `LeaveRequest` ADD COLUMN `halfStart` VARCHAR(5) NULL;
ALTER TABLE `LeaveRequest` ADD COLUMN `halfEnd` VARCHAR(5) NULL;
