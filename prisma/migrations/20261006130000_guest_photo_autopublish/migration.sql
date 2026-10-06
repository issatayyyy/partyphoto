BEGIN;

-- Match the application's event-before-photo lock order and apply the default
-- and legacy content update atomically.
ALTER TABLE "Event" ALTER COLUMN "moderateUploads" SET DEFAULT false;

UPDATE "Event"
SET "mediaVersion" = "mediaVersion" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "Photo"
  WHERE "Photo"."eventId" = "Event"."id" AND "Photo"."status" = 'PENDING'
);

UPDATE "Photo"
SET "status" = 'PUBLISHED', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'PENDING';

UPDATE "Event"
SET "moderateUploads" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "moderateUploads" = true;

COMMIT;
