import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import type { ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";

const DEFAULT_INSTANCE_SETTINGS_KEY = "default";
export const COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED =
  "company_isolated_project_workspace_required";

export type CompanyProjectIsolationGuard = {
  required: boolean;
  isolatedWorkspacesEnabled: boolean;
};

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function isRequiredIsolatedProjectWorkspacePolicy(raw: unknown): boolean {
  const policy = parseProjectExecutionWorkspacePolicy(raw);
  return policy?.enabled === true
    && policy.defaultMode === "isolated_workspace"
    && policy.allowIssueOverride === false;
}

export function assertCompanyProjectIsolationPolicy(
  guard: CompanyProjectIsolationGuard,
  rawPolicy: ProjectExecutionWorkspacePolicy | Record<string, unknown> | null | undefined,
): void {
  if (!guard.required) return;
  if (guard.isolatedWorkspacesEnabled && isRequiredIsolatedProjectWorkspacePolicy(rawPolicy)) return;

  throw conflict(
    "This company requires every project to use isolated workspaces without issue overrides.",
    { code: COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED },
  );
}

export async function withCompanyProjectIsolationLock<T>(
  db: Db,
  companyId: string,
  operation: (tx: DbTransaction, guard: CompanyProjectIsolationGuard) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const company = await tx
      .select({
        id: companies.id,
        requireIsolatedProjectWorkspaces: companies.requireIsolatedProjectWorkspaces,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const settings = await tx
      .select({ experimental: instanceSettings.experimental })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_INSTANCE_SETTINGS_KEY))
      .then((rows) => rows[0] ?? null);

    return operation(tx, {
      required: company.requireIsolatedProjectWorkspaces,
      isolatedWorkspacesEnabled:
        settings?.experimental?.enableIsolatedWorkspaces === true,
    });
  });
}
