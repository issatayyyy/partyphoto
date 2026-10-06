-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AuthRateLimit_resetAt_idx" ON "AuthRateLimit"("resetAt");
