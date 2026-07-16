// Issue-level assigneeAdapterOverrides.adapterConfig is merged verbatim over
// the assignee agent's adapter config at dispatch, so a CLI flag that belongs
// to a different adapter crashes every run touching the issue at argv parse
// ("error: unknown option") - including review and recovery wakes that a
// cancel does not stop. A codex-only --skip-git-repo-check override on a
// claude agent's issue crashed 80 runs across 9 agents before it was cleared.
//
// The registry lists flags Paperclip knows to be exclusive to specific adapter
// types. It is deliberately small and precise: freeform extraArgs stay allowed
// (they are passthrough by design); only a flag proven to belong to another
// adapter is rejected. Grow the map as new cross-adapter mistakes are
// diagnosed. Enforced at the issue write path (422) and again pre-dispatch
// (ConfigurationIncompleteFailure) so overrides written before this guard, via
// import, or invalidated by a later reassignment still fail fast with a named
// cause instead of an opaque CLI crash loop.
export const ADAPTER_EXCLUSIVE_CLI_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "--skip-git-repo-check": ["codex_local"],
};

export type ForeignAdapterCliArgFinding = {
  configKey: "extraArgs" | "args";
  flag: string;
  validAdapterTypes: readonly string[];
};

export const ADAPTER_CLI_ARG_CONFIG_KEYS = ["extraArgs", "args"] as const;

function cliFlagToken(arg: string): string {
  const eq = arg.indexOf("=");
  return (eq === -1 ? arg : arg.slice(0, eq)).trim();
}

export function findForeignAdapterCliArgs(
  adapterType: string | null | undefined,
  adapterConfig: unknown,
): ForeignAdapterCliArgFinding[] {
  if (!adapterType) return [];
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return [];
  const record = adapterConfig as Record<string, unknown>;
  const findings: ForeignAdapterCliArgFinding[] = [];
  for (const configKey of ADAPTER_CLI_ARG_CONFIG_KEYS) {
    const value = record[configKey];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const flag = cliFlagToken(entry);
      const validAdapterTypes = ADAPTER_EXCLUSIVE_CLI_FLAGS[flag];
      if (validAdapterTypes && !validAdapterTypes.includes(adapterType)) {
        findings.push({ configKey, flag, validAdapterTypes });
      }
    }
  }
  return findings;
}
