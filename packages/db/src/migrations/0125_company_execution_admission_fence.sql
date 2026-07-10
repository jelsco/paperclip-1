ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "execution_admission_fence_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "execution_admission_fenced_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "execution_admission_fence_token_hash" text,
  ADD COLUMN IF NOT EXISTS "execution_admission_fence_reason" text,
  ADD COLUMN IF NOT EXISTS "execution_admission_fenced_by_user_id" text;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_execution_admission_fence_complete_chk"
  CHECK (
    ("execution_admission_fenced_at" IS NULL
      AND "execution_admission_fence_token_hash" IS NULL
      AND "execution_admission_fence_reason" IS NULL
      AND "execution_admission_fenced_by_user_id" IS NULL)
    OR
    ("execution_admission_fenced_at" IS NOT NULL
      AND "execution_admission_fence_token_hash" IS NOT NULL
      AND "execution_admission_fence_reason" IS NOT NULL)
  );
