import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

// Local override: PAPERCLIP_VERSION env var beats the stale package.json
// (upstream pins server/package.json at 0.3.1 across date-versioned releases).
// Set in the systemd unit; bump on every upgrade. See infra/paperclip-server/README.md.
const envOverride = process.env.PAPERCLIP_VERSION?.trim();
export const serverVersion =
  envOverride && envOverride.length > 0 ? envOverride : (pkg.version ?? "0.0.0");
