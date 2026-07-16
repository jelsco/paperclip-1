import { describe, expect, it } from "vitest";
import { findForeignAdapterCliArgs } from "./adapter-args.js";

describe("findForeignAdapterCliArgs", () => {
  it("flags a codex-only extraArgs flag on a claude adapter", () => {
    const findings = findForeignAdapterCliArgs("claude_local", {
      extraArgs: ["--skip-git-repo-check"],
    });
    expect(findings).toEqual([
      {
        configKey: "extraArgs",
        flag: "--skip-git-repo-check",
        validAdapterTypes: ["codex_local"],
      },
    ]);
  });

  it("allows the flag on its own adapter type", () => {
    expect(findForeignAdapterCliArgs("codex_local", {
      extraArgs: ["--skip-git-repo-check"],
    })).toEqual([]);
  });

  it("matches --flag=value forms and the args key", () => {
    const findings = findForeignAdapterCliArgs("claude_local", {
      args: ["--skip-git-repo-check=true"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.configKey).toBe("args");
    expect(findings[0]?.flag).toBe("--skip-git-repo-check");
  });

  it("ignores benign overrides, unknown flags, and malformed shapes", () => {
    expect(findForeignAdapterCliArgs("claude_local", { modelProfile: "cheap" })).toEqual([]);
    expect(findForeignAdapterCliArgs("claude_local", { extraArgs: ["--verbose"] })).toEqual([]);
    expect(findForeignAdapterCliArgs("claude_local", { extraArgs: "not-an-array" })).toEqual([]);
    expect(findForeignAdapterCliArgs("claude_local", { extraArgs: [42] })).toEqual([]);
    expect(findForeignAdapterCliArgs("claude_local", null)).toEqual([]);
    expect(findForeignAdapterCliArgs(null, { extraArgs: ["--skip-git-repo-check"] })).toEqual([]);
  });
});
