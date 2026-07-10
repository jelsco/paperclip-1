import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { executionAdmissionService } from "../services/execution-admission.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company execution admission fence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fence Test",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, status = "idle") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status,
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("uses a single-winner fence and token plus version CAS to reopen", async () => {
    const companyId = await seedCompany();
    const service = executionAdmissionService(db);

    const attempts = await Promise.allSettled([
      service.fence({ companyId, reason: "runtime cutover", userId: "board-a" }),
      service.fence({ companyId, reason: "competing cutover", userId: "board-b" }),
    ]);
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.fence>>> =>
        attempt.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const fence = winners[0]!.value;
    expect(fence).toMatchObject({ companyId, fenced: true, version: 1, reason: "runtime cutover" });
    expect(fence.token).toBeTruthy();
    expect(await service.getState(companyId)).toMatchObject({ fenced: true, version: 1 });

    await expect(service.reopen({ companyId, token: "wrong-token", version: fence.version }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.reopen({ companyId, token: fence.token, version: fence.version + 1 }))
      .rejects.toMatchObject({ status: 409 });

    const reopened = await service.reopen({ companyId, token: fence.token, version: fence.version });
    expect(reopened).toMatchObject({ companyId, fenced: false, version: 2, reason: null });
    await expect(service.reopen({ companyId, token: fence.token, version: fence.version }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("durably skips system producers and rejects user wakeups while preserving existing runs", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const queuedRunId = randomUUID();
    const runningRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        status: "queued",
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      },
    ]);

    const fence = await executionAdmissionService(db).fence({
      companyId,
      reason: "runtime cutover",
      userId: "board",
    });
    const heartbeat = heartbeatService(db);

    const systemProducers = [
      { source: "assignment" as const, reason: "issue_assigned" },
      { source: "automation" as const, reason: "issue_assignment_recovery" },
      { source: "automation" as const, reason: "task_watchdog_stopped_subtree" },
      { source: "automation" as const, reason: "issue_continuation_needed" },
      { source: "timer" as const, reason: "scheduled_heartbeat" },
    ];
    for (const producer of systemProducers) {
      await expect(heartbeat.wakeup(agentId, {
        ...producer,
        requestedByActorType: "system",
      })).resolves.toBeNull();
    }
    await expect(heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board",
    })).rejects.toMatchObject({ status: 409 });

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(skipped).toHaveLength(systemProducers.length + 1);
    expect(skipped.every((row) => row.status === "skipped")).toBe(true);
    expect(skipped.every((row) => row.reason === "company.execution_admission_fenced")).toBe(true);

    const existingRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(existingRuns).toEqual(expect.arrayContaining([
      { id: queuedRunId, status: "queued" },
      { id: runningRunId, status: "running" },
    ]));

    await executionAdmissionService(db).reopen({
      companyId,
      token: fence.token,
      version: fence.version,
    });
  });

  it("blocks agent create, resume, clear-error, and pending activation paths", async () => {
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, "paused");
    const errorAgentId = await seedAgent(companyId, "error");
    const pendingAgentId = await seedAgent(companyId, "pending_approval");
    await executionAdmissionService(db).fence({
      companyId,
      reason: "runtime cutover",
      userId: "board",
    });

    const agentsService = agentService(db);
    await expect(agentsService.create(companyId, {
      name: "New Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      status: "idle",
    })).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.resume(pausedAgentId)).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.clearError(errorAgentId)).rejects.toMatchObject({ status: 409 });
    await expect(agentsService.activatePendingApproval(pendingAgentId)).rejects.toMatchObject({ status: 409 });

    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { agentId: pendingAgentId },
    }).returning();
    await expect(approvalService(db).approve(approval!.id, "board"))
      .rejects.toMatchObject({ status: 409 });
    const unchanged = await db.select().from(approvals).where(eq(approvals.id, approval!.id));
    expect(unchanged[0]?.status).toBe("pending");
  });

  it("records routine producers as skipped without creating an issue or wake", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const [routine] = await db.insert(routines).values({
      companyId,
      title: "Fenced routine",
      description: "Must not dispatch",
      assigneeAgentId: agentId,
    }).returning();
    await executionAdmissionService(db).fence({
      companyId,
      reason: "runtime cutover",
      userId: "board",
    });

    const wakeup = vi.fn(async () => null);
    const service = routineService(db, { heartbeat: { wakeup } });
    for (const source of ["manual", "api", "schedule", "webhook"] as const) {
      const run = await service.runRoutine(
        routine!.id,
        { source },
        { userId: "board" },
      );
      expect(run).toMatchObject({
        companyId,
        routineId: routine!.id,
        source,
        status: "skipped",
        failureReason: "company.execution_admission_fenced",
        linkedIssueId: null,
      });
    }
    expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
  });
});
