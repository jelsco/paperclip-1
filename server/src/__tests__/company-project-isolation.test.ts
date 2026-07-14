import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  instanceSettings,
  pluginManagedResources,
  plugins,
  projects as projectsTable,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";
import {
  COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED,
  withCompanyProjectIsolationLock,
} from "../services/company-project-isolation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company project isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company project isolation policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginManagedResources);
    await db.delete(projectsTable);
    await db.delete(plugins);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(required: boolean): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Isolation Test",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireIsolatedProjectWorkspaces: required,
    });
    return companyId;
  }

  async function setGlobalCapability(enabled: boolean): Promise<void> {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      experimental: { enableIsolatedWorkspaces: enabled },
    }).onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: { experimental: { enableIsolatedWorkspaces: enabled } },
    });
  }

  const requiredPolicy = {
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: false,
  } as const;

  it.each([
    ["missing policy", null],
    ["disabled policy", { ...requiredPolicy, enabled: false }],
    ["shared default", { ...requiredPolicy, defaultMode: "shared_workspace" }],
    ["issue override", { ...requiredPolicy, allowIssueOverride: true }],
  ])("rejects %s before inserting a project", async (_label, executionWorkspacePolicy) => {
    const companyId = await seedCompany(true);
    await setGlobalCapability(true);

    await expect(projectService(db).create(companyId, {
      name: "Unsafe",
      executionWorkspacePolicy,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED },
    });

    const rows = await db.select().from(projectsTable);
    expect(rows).toHaveLength(0);
  });

  it("requires the global capability and accepts only the exact safe policy", async () => {
    const companyId = await seedCompany(true);
    await setGlobalCapability(false);
    const projects = projectService(db);

    await expect(projects.create(companyId, {
      name: "Blocked",
      executionWorkspacePolicy: requiredPolicy,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED },
    });

    await db.update(instanceSettings).set({
      experimental: { enableIsolatedWorkspaces: true },
    });
    const created = await projects.create(companyId, {
      name: "Safe",
      executionWorkspacePolicy: requiredPolicy,
    });
    expect(created.executionWorkspacePolicy).toEqual(requiredPolicy);
  });

  it("keeps archived project shortnames reserved during guarded creation", async () => {
    const companyId = await seedCompany(true);
    await setGlobalCapability(true);
    await db.insert(projectsTable).values({
      companyId,
      name: "Launch",
      archivedAt: new Date(),
      executionWorkspacePolicy: requiredPolicy,
    });

    const created = await projectService(db).create(companyId, {
      name: "Launch",
      executionWorkspacePolicy: requiredPolicy,
    });
    expect(created.name).toBe("Launch 2");
  });

  it("preserves the stable conflict on plugin-managed project creation", async () => {
    const companyId = await seedCompany(true);
    await setGlobalCapability(true);
    const [plugin] = await db.insert(plugins).values({
      pluginKey: "isolation-test",
      packageName: "@test/isolation",
      version: "1.0.0",
      manifestJson: {
        id: "isolation-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Isolation Test",
        entry: "index.js",
        projects: [{ projectKey: "managed", displayName: "Managed" }],
      } as never,
    }).returning();

    await expect(projectService(db).resolveManagedProject({
      companyId,
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      projectKey: "managed",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: COMPANY_ISOLATED_PROJECT_WORKSPACE_REQUIRED },
    });
  });

  it("serializes a reconciler policy flip behind the portability lock", async () => {
    const companyId = await seedCompany(false);
    await setGlobalCapability(true);
    const reconcilerDb = createDb(tempDb!.connectionString);
    let releaseImport!: () => void;
    const importCanFinish = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let importHasLock!: () => void;
    const importLocked = new Promise<void>((resolve) => {
      importHasLock = resolve;
    });

    const importOperation = withCompanyProjectIsolationLock(db, companyId, async () => {
      importHasLock();
      await importCanFinish;
    });
    await importLocked;

    let reconcilerFinished = false;
    const reconcilerOperation = reconcilerDb
      .update(companies)
      .set({ requireIsolatedProjectWorkspaces: true })
      .where(eq(companies.id, companyId))
      .then(() => {
        reconcilerFinished = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconcilerFinished).toBe(false);

    releaseImport();
    await Promise.all([importOperation, reconcilerOperation]);
    expect(reconcilerFinished).toBe(true);
  });
});
