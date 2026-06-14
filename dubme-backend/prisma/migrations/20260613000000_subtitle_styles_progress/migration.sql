-- Subtitle style system + progress + background-refine fields.
-- Note: subtitle size/width fields are px at a 1080p reference (burn .ass uses
-- native PlayRes and scales by height/1080; preview scales the same way).

ALTER TABLE "Job"
  ADD COLUMN     "subtitleFontFamily"   TEXT             NOT NULL DEFAULT 'Noto Sans',
  ADD COLUMN     "subtitleBold"         BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN     "subtitleItalic"       BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN     "subtitleOutlineWidth" DOUBLE PRECISION NOT NULL DEFAULT 3,
  ADD COLUMN     "subtitleOutlineColor" TEXT             NOT NULL DEFAULT '#000000',
  ADD COLUMN     "subtitleOutlineAlpha" INTEGER          NOT NULL DEFAULT 80,
  ADD COLUMN     "subtitleShadowDepth"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN     "subtitleShadowColor"  TEXT             NOT NULL DEFAULT '#000000',
  ADD COLUMN     "subtitleBgOpacity"    INTEGER          NOT NULL DEFAULT 75,
  ADD COLUMN     "subtitleAlign"        TEXT             NOT NULL DEFAULT 'center',
  ADD COLUMN     "subtitleMarginHPct"   INTEGER          NOT NULL DEFAULT 4,
  ADD COLUMN     "subtitleLetterSpacing" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN     "subtitleZhScale"      DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  ADD COLUMN     "subtitleZhColor"      TEXT,
  ADD COLUMN     "capTo1080"            BOOLEAN          NOT NULL DEFAULT true,
  ADD COLUMN     "progress"             INTEGER          DEFAULT 0,
  ADD COLUMN     "progressNote"         TEXT,
  ADD COLUMN     "refining"             BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN     "refineError"          TEXT;

-- New default for the font-size unit change (px @ 1080p). Existing rows keep
-- their stored value; only the column default changes for new jobs.
ALTER TABLE "Job" ALTER COLUMN "subtitleFontSize" SET DEFAULT 48;
