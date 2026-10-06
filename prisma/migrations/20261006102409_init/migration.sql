-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ORGANIZER', 'PHOTOGRAPHER');

-- CreateEnum
CREATE TYPE "EventRole" AS ENUM ('ORGANIZER', 'PHOTOGRAPHER');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'PENDING', 'PUBLISHED', 'HIDDEN', 'FAILED', 'DELETING');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('THUMBNAIL', 'ZIP', 'DELETE_MEDIA', 'EXPIRE_EVENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ORGANIZER',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "accessVersion" INTEGER NOT NULL DEFAULT 1,
    "allowGuestUploads" BOOLEAN NOT NULL DEFAULT false,
    "moderateUploads" BOOLEAN NOT NULL DEFAULT true,
    "allowDownloads" BOOLEAN NOT NULL DEFAULT true,
    "maxPhotos" INTEGER NOT NULL DEFAULT 1000,
    "maxStorageBytes" BIGINT NOT NULL DEFAULT 10737418240,
    "maxUploadBytes" INTEGER NOT NULL DEFAULT 26214400,
    "usedStorageBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "viewCount" BIGINT NOT NULL DEFAULT 0,
    "downloadCount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMember" (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "EventRole" NOT NULL,

    CONSTRAINT "EventMember_pkey" PRIMARY KEY ("eventId","userId")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "uploaderId" TEXT,
    "originalKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "thumbnailBytes" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "status" "PhotoStatus" NOT NULL DEFAULT 'UPLOADING',
    "uploadExpiresAt" TIMESTAMP(3),
    "downloadCount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "accessVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaJob" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "resultKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_code_key" ON "Event"("code");

-- CreateIndex
CREATE INDEX "Event_ownerId_createdAt_idx" ON "Event"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Event_expiresAt_idx" ON "Event"("expiresAt");

-- CreateIndex
CREATE INDEX "EventMember_userId_idx" ON "EventMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_originalKey_key" ON "Photo"("originalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_thumbnailKey_key" ON "Photo"("thumbnailKey");

-- CreateIndex
CREATE INDEX "Photo_eventId_status_createdAt_id_idx" ON "Photo"("eventId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Photo_status_uploadExpiresAt_idx" ON "Photo"("status", "uploadExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_tokenHash_key" ON "AccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccessToken_eventId_idx" ON "AccessToken"("eventId");

-- CreateIndex
CREATE INDEX "AccessToken_expiresAt_idx" ON "AccessToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaJob_dedupeKey_key" ON "MediaJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "MediaJob_status_availableAt_idx" ON "MediaJob"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMember" ADD CONSTRAINT "EventMember_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMember" ADD CONSTRAINT "EventMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaJob" ADD CONSTRAINT "MediaJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
