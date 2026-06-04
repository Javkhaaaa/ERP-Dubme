-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('UPLOADED', 'EXTRACTING', 'TRANSCRIBING', 'TRANSLATING', 'EDITING', 'SYNTHESIZING', 'MUXING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'UPLOADED',
    "sourceLanguage" TEXT NOT NULL DEFAULT 'zh',
    "targetLanguage" TEXT NOT NULL DEFAULT 'mn',
    "voiceName" TEXT,
    "inputKey" TEXT,
    "audioKey" TEXT,
    "outputKey" TEXT,
    "subtitleKey" TEXT,
    "stylePrompt" TEXT,
    "temperature" DOUBLE PRECISION DEFAULT 1.0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "sourceText" TEXT NOT NULL,
    "translatedText" TEXT,
    "audioKey" TEXT,
    "audioDuration" DOUBLE PRECISION,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "Segment_jobId_idx" ON "Segment"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Segment_jobId_sequence_key" ON "Segment"("jobId", "sequence");

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
