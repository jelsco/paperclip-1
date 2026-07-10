import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

export type ExecutionAdmissionState = {
  companyId: string;
  fenced: boolean;
  version: number;
  fencedAt: Date | null;
  reason: string | null;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function toState(row: {
  id: string;
  executionAdmissionFenceVersion: number;
  executionAdmissionFencedAt: Date | null;
  executionAdmissionFenceReason: string | null;
}): ExecutionAdmissionState {
  return {
    companyId: row.id,
    fenced: row.executionAdmissionFencedAt != null,
    version: row.executionAdmissionFenceVersion,
    fencedAt: row.executionAdmissionFencedAt,
    reason: row.executionAdmissionFenceReason,
  };
}

export function executionAdmissionService(db: Db) {
  const stateColumns = {
    id: companies.id,
    executionAdmissionFenceVersion: companies.executionAdmissionFenceVersion,
    executionAdmissionFencedAt: companies.executionAdmissionFencedAt,
    executionAdmissionFenceReason: companies.executionAdmissionFenceReason,
  };

  async function getState(companyId: string): Promise<ExecutionAdmissionState> {
    const row = await db
      .select(stateColumns)
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return toState(row);
  }

  async function assertOpen(companyId: string): Promise<ExecutionAdmissionState> {
    const state = await getState(companyId);
    if (state.fenced) {
      throw conflict("Company execution admission is fenced", {
        code: "company_execution_admission_fenced",
        version: state.version,
      });
    }
    return state;
  }

  return {
    getState,
    assertOpen,

    fence: async (input: {
      companyId: string;
      reason: string;
      userId: string | null;
    }): Promise<ExecutionAdmissionState & { token: string }> => {
      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const updated = await db
        .update(companies)
        .set({
          executionAdmissionFenceVersion: sql`${companies.executionAdmissionFenceVersion} + 1`,
          executionAdmissionFencedAt: now,
          executionAdmissionFenceTokenHash: tokenHash(token),
          executionAdmissionFenceReason: input.reason,
          executionAdmissionFencedByUserId: input.userId,
          updatedAt: now,
        })
        .where(and(eq(companies.id, input.companyId), isNull(companies.executionAdmissionFencedAt)))
        .returning(stateColumns)
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        const state = await getState(input.companyId);
        throw conflict("Company execution admission is already fenced", {
          code: "company_execution_admission_already_fenced",
          version: state.version,
        });
      }
      return { ...toState(updated), token };
    },

    reopen: async (input: {
      companyId: string;
      token: string;
      version: number;
    }): Promise<ExecutionAdmissionState> => {
      const now = new Date();
      const updated = await db
        .update(companies)
        .set({
          executionAdmissionFenceVersion: sql`${companies.executionAdmissionFenceVersion} + 1`,
          executionAdmissionFencedAt: null,
          executionAdmissionFenceTokenHash: null,
          executionAdmissionFenceReason: null,
          executionAdmissionFencedByUserId: null,
          updatedAt: now,
        })
        .where(and(
          eq(companies.id, input.companyId),
          isNotNull(companies.executionAdmissionFencedAt),
          eq(companies.executionAdmissionFenceVersion, input.version),
          eq(companies.executionAdmissionFenceTokenHash, tokenHash(input.token)),
        ))
        .returning(stateColumns)
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        const state = await getState(input.companyId);
        throw conflict("Execution admission fence token or version is stale", {
          code: "company_execution_admission_fence_mismatch",
          version: state.version,
          fenced: state.fenced,
        });
      }
      return toState(updated);
    },
  };
}
