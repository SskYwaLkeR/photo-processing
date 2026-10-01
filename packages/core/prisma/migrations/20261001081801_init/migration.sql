-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'COMPLETE', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('CONVERT', 'COMPRESS', 'VARIANTS');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "VariantName" AS ENUM ('THUMB', 'WEB', 'FULL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'UPLOADING',
    "stage" "Stage",
    "run" INTEGER NOT NULL DEFAULT 0,
    "pipeline_version" VARCHAR(20),
    "idempotency_key" VARCHAR(100),
    "original_filename" VARCHAR(255) NOT NULL,
    "declared_mime" VARCHAR(100) NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "original_key" TEXT NOT NULL,
    "original_format" VARCHAR(10),
    "original_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "normalized_key" TEXT,
    "normalized_bytes" INTEGER,
    "master_key" TEXT,
    "compressed_bytes" INTEGER,
    "compression_ratio" DOUBLE PRECISION,
    "compression_quality" INTEGER,
    "error_stage" "Stage",
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(500),
    "retryable" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "run" INTEGER NOT NULL,
    "stage" "Stage" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" VARCHAR(100),
    "last_error" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "image_id" UUID NOT NULL,
    "name" "VariantName" NOT NULL,
    "run" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("image_id","name")
);

-- CreateTable
CREATE TABLE "image_events" (
    "id" BIGSERIAL NOT NULL,
    "image_id" UUID NOT NULL,
    "run" INTEGER NOT NULL,
    "stage" "Stage",
    "type" VARCHAR(40) NOT NULL,
    "detail" VARCHAR(500),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" VARCHAR(100) NOT NULL,
    "stage" "Stage" NOT NULL,
    "pid" INTEGER NOT NULL,
    "concurrency" INTEGER NOT NULL,
    "in_flight" INTEGER NOT NULL DEFAULT 0,
    "draining" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "images_user_id_created_at_idx" ON "images"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "images_user_id_idempotency_key_key" ON "images"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "tasks_stage_status_finished_at_idx" ON "tasks"("stage", "status", "finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_image_id_run_stage_key" ON "tasks"("image_id", "run", "stage");

-- CreateIndex
CREATE INDEX "image_events_image_id_id_idx" ON "image_events"("image_id", "id");

-- CreateIndex
CREATE INDEX "workers_stage_heartbeat_at_idx" ON "workers"("stage", "heartbeat_at");

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_events" ADD CONSTRAINT "image_events_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants Prisma can't express
ALTER TABLE "images" ADD CONSTRAINT images_failure_has_reason
  CHECK (status NOT IN ('FAILED', 'REJECTED') OR (error_code IS NOT NULL AND error_message IS NOT NULL));
ALTER TABLE "images" ADD CONSTRAINT images_failed_has_stage CHECK (status <> 'FAILED' OR error_stage IS NOT NULL);
CREATE INDEX images_in_flight_idx ON "images" (user_id) WHERE status IN ('UPLOADING', 'PROCESSING');
-- At most one QUEUED/RUNNING task per image, enforced by the database
CREATE UNIQUE INDEX tasks_one_active_per_image ON "tasks" (image_id) WHERE status IN ('QUEUED', 'RUNNING');
-- The claim scan only touches active rows, so it stays tiny as the table grows
CREATE INDEX tasks_claim_idx ON "tasks" (stage, available_at) WHERE status IN ('QUEUED', 'RUNNING');
