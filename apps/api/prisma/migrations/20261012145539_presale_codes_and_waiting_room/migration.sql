-- AlterTable
ALTER TABLE "performances" ADD COLUMN     "waiting_room_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "presale_codes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sale_phase_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "redeemed_by" UUID,
    "redeemed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presale_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "presale_codes_code_key" ON "presale_codes"("code");

-- CreateIndex
CREATE INDEX "presale_codes_sale_phase_id_idx" ON "presale_codes"("sale_phase_id");

-- AddForeignKey
ALTER TABLE "presale_codes" ADD CONSTRAINT "presale_codes_sale_phase_id_fkey" FOREIGN KEY ("sale_phase_id") REFERENCES "sale_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presale_codes" ADD CONSTRAINT "presale_codes_redeemed_by_fkey" FOREIGN KEY ("redeemed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- I11: one account redeems at most one code per sale phase. Without this a
-- single account could burn every code it can guess or buy. Partial: unused
-- codes (redeemed_by IS NULL) are not constrained.
CREATE UNIQUE INDEX "presale_codes_sale_phase_id_redeemed_by_key"
  ON "presale_codes"("sale_phase_id", "redeemed_by")
  WHERE "redeemed_by" IS NOT NULL;

-- A code is either unused (both NULL) or used by someone at some time.
ALTER TABLE "presale_codes" ADD CONSTRAINT "presale_codes_redeemed_together"
  CHECK (("redeemed_by" IS NULL) = ("redeemed_at" IS NULL));
