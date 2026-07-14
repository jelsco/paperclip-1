ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "require_isolated_project_workspaces" boolean NOT NULL DEFAULT false;
