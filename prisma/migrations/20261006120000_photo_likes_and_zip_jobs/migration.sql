ALTER TABLE "Event" ADD COLUMN "mediaVersion" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "PhotoLike" (
  "photoId" TEXT NOT NULL,
  "voterHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhotoLike_pkey" PRIMARY KEY ("photoId", "voterHash"),
  CONSTRAINT "PhotoLike_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "MediaJob"
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "totalPhotos" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processedPhotos" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sizeBytes" BIGINT NOT NULL DEFAULT 0;
CREATE INDEX "MediaJob_kind_expiresAt_idx" ON "MediaJob"("kind", "expiresAt");
