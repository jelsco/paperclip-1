import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { shouldExcludePath } from "./exclude-patterns.js";

type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry>;
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkDirectory(
  root: string,
  exclude: readonly string[],
  relative = "",
  out: Map<string, SnapshotEntry> = new Map(),
): Promise<Map<string, SnapshotEntry>> {
  const current = relative ? path.join(root, relative) : root;
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExcludePath(nextRelative, exclude)) continue;

    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath);
    if (!stats.isDirectory() && !stats.isSymbolicLink() && !stats.isFile()) {
      continue;
    }

    if (stats.isDirectory()) {
      out.set(nextRelative, { kind: "dir" });
      await walkDirectory(root, exclude, nextRelative, out);
      continue;
    }

    if (stats.isSymbolicLink()) {
      out.set(nextRelative, {
        kind: "symlink",
        target: await fs.readlink(fullPath),
      });
      continue;
    }

    out.set(nextRelative, {
      kind: "file",
      mode: stats.mode,
      hash: await hashFile(fullPath),
    });
  }

  return out;
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

function pathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveContained(root: string, relative: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, relative);
  if (!pathContained(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes workspace root: ${relative}`);
  }
  return resolvedCandidate;
}

async function assertRealPathContained(root: string, candidate: string, label: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const realRoot = await fs.realpath(resolvedRoot);
  const realCandidate = await fs.realpath(candidate).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is dangling or unreadable: ${message}`);
  });
  if (!pathContained(realRoot, realCandidate)) {
    throw new Error(`${label} resolves outside workspace root`);
  }
}

async function assertSafeSymlinkPlan(input: {
  sourceDir: string;
  targetDir: string;
  relative: string;
  entry: Extract<SnapshotEntry, { kind: "symlink" }>;
}): Promise<void> {
  if (path.isAbsolute(input.entry.target)) {
    throw new Error(`Refusing to restore absolute symlink target at ${input.relative}`);
  }

  const sourcePath = resolveContained(input.sourceDir, input.relative, "Restore source symlink path");
  const targetPath = resolveContained(input.targetDir, input.relative, "Restore target symlink path");
  const currentSourceStats = await fs.lstat(sourcePath).catch(() => null);
  if (!currentSourceStats?.isSymbolicLink()) {
    throw new Error(`Restore source changed while applying symlink: ${input.relative}`);
  }
  const currentTarget = await fs.readlink(sourcePath);
  if (currentTarget !== input.entry.target) {
    throw new Error(`Restore source symlink target changed while applying: ${input.relative}`);
  }

  const sourceTarget = path.resolve(path.dirname(sourcePath), input.entry.target);
  if (!pathContained(path.resolve(input.sourceDir), sourceTarget)) {
    throw new Error(`Refusing to restore source symlink escaping workspace at ${input.relative}`);
  }
  await assertRealPathContained(input.sourceDir, sourceTarget, `Restore source symlink at ${input.relative}`);

  const targetTarget = path.resolve(path.dirname(targetPath), input.entry.target);
  if (!pathContained(path.resolve(input.targetDir), targetTarget)) {
    throw new Error(`Refusing to create target symlink escaping workspace at ${input.relative}`);
  }
}

async function assertSafeRestoreSymlinkPlan(source: DirectorySnapshot, sourceDir: string, targetDir: string): Promise<void> {
  for (const [relative, entry] of source.entries.entries()) {
    if (entry.kind !== "symlink") continue;
    await assertSafeSymlinkPlan({ sourceDir, targetDir, relative, entry });
  }
}

async function isHolderAlive(lockDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof owner.pid === "number" && Number.isFinite(owner.pid) && owner.pid > 0 ? owner.pid : null;
    if (pid === null) {
      // Owner record is unparseable / missing pid — treat as stale.
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    // owner.json missing or unreadable — treat as stale.
    return false;
  }
}

async function acquireDirectoryMergeLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw error;
      // Stale-lock detection: if the owner PID is dead (SIGKILL / OOM / crash),
      // the lockDir would otherwise persist forever and stall restores. Mirror
      // the materializePaperclipSkillCopy lock pattern — remove and retry.
      if (!(await isHolderAlive(lockDir))) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace restore lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireDirectoryMergeLock(`${targetDir}.paperclip-restore.lock`);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = resolveContained(sourceDir, relative, "Restore source path");
  const targetPath = resolveContained(targetDir, relative, "Restore target path");

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (entry.kind === "symlink") {
    await assertSafeSymlinkPlan({ sourceDir, targetDir, relative, entry });
    await fs.symlink(entry.target, targetPath);
    return;
  }

  const sourceStats = await fs.lstat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`Restore source changed while copying file: ${relative}`);
  }
  await assertRealPathContained(sourceDir, sourcePath, `Restore source file at ${relative}`);
  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, entry.mode);
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[] } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  return {
    exclude,
    entries: await walkDirectory(rootDir, exclude),
  };
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}): Promise<void> {
  await withDirectoryMergeLock(input.targetDir, async () => {
    await input.beforeApply?.();
    const source = await captureDirectorySnapshot(input.sourceDir, { exclude: input.baseline.exclude });
    await assertSafeRestoreSymlinkPlan(source, input.sourceDir, input.targetDir);
    const current = await captureDirectorySnapshot(input.targetDir, { exclude: input.baseline.exclude });
    const deletedLeafEntries = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind !== "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedLeafEntries) {
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      await fs.rm(path.join(input.targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }

    const deletedDirs = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind === "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative] of deletedDirs) {
      await fs.rmdir(path.join(input.targetDir, relative)).catch(() => undefined);
    }

    const changedSourceEntries = [...source.entries.entries()]
      .filter(([relative, entry]) => !entriesMatch(input.baseline.entries.get(relative), entry))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [relative, entry] of changedSourceEntries) {
      await copySnapshotEntry(input.sourceDir, input.targetDir, relative, entry);
    }

    await input.afterApply?.();
  });
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
