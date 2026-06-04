-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "outputMode" TEXT NOT NULL DEFAULT 'dub';
ALTER TABLE "Job" ADD COLUMN     "subtitleBurn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN     "subtitleText" TEXT NOT NULL DEFAULT 'translated';
