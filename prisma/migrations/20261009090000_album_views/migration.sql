CREATE TABLE "AlbumView" (
  "eventId" TEXT NOT NULL,
  "visitorHash" TEXT NOT NULL,
  "lastCountedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlbumView_pkey" PRIMARY KEY ("eventId", "visitorHash")
);

CREATE INDEX "AlbumView_lastCountedAt_idx" ON "AlbumView"("lastCountedAt");

ALTER TABLE "AlbumView" ADD CONSTRAINT "AlbumView_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
