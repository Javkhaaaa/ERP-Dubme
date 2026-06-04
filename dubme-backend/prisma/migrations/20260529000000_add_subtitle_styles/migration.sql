-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "subtitleFontSize" INTEGER NOT NULL DEFAULT 22;
ALTER TABLE "Job" ADD COLUMN     "subtitleTextColor" TEXT NOT NULL DEFAULT '#FFFFFF';
ALTER TABLE "Job" ADD COLUMN     "subtitleBgColor" TEXT;
ALTER TABLE "Job" ADD COLUMN     "subtitlePosition" TEXT NOT NULL DEFAULT 'bottom';
