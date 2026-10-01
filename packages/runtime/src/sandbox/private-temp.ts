import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { RunId } from "@caelush/protocol";
import { RuntimePrivateTempError } from "../runtime-errors.js";

const PRIVATE_TEMP_PREFIX = "caelush-run-";
const PRIVATE_TEMP_MARKER = ".caelush-private-temp.json";
const PRIVATE_TEMP_MARKER_VALUE = "CAELUSH_PRIVATE_RUN_TEMP_V1";

export interface PrivateRunTemp {
  readonly root: string;
  readonly markerPath: string;
  readonly runId: RunId;
  readonly markerId: string;
}

export interface PrivateRunTempOptions {
  readonly baseDirectory?: string;
}

export async function createPrivateRunTemp(
  runId: RunId,
  options: PrivateRunTempOptions = {},
): Promise<PrivateRunTemp> {
  const baseDirectory = path.resolve(options.baseDirectory ?? os.tmpdir());
  const root = await mkdtemp(path.join(baseDirectory, PRIVATE_TEMP_PREFIX));
  const markerId = crypto.randomUUID();
  const markerPath = path.join(root, PRIVATE_TEMP_MARKER);
  const marker = {
    schemaVersion: 1,
    marker: PRIVATE_TEMP_MARKER_VALUE,
    markerId,
    runId,
  } as const;
  await writeFile(markerPath, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ root, markerPath, runId, markerId });
}

export async function cleanupPrivateRunTemp(temp: PrivateRunTemp): Promise<void> {
  await assertPrivateTempMarker(temp);
  await rm(temp.root, { recursive: true, force: false });
}

export async function cleanupStalePrivateRunTemps(input: {
  readonly baseDirectory?: string;
  readonly maxAgeMs: number;
}): Promise<readonly string[]> {
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs < 0) {
    throw new RuntimePrivateTempError("Private temp age bound is invalid.");
  }
  const baseDirectory = path.resolve(input.baseDirectory ?? os.tmpdir());
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(baseDirectory, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PRIVATE_TEMP_PREFIX)) continue;
    const root = path.join(baseDirectory, entry.name);
    const markerPath = path.join(root, PRIVATE_TEMP_MARKER);
    try {
      const metadata = await stat(markerPath);
      if (Date.now() - metadata.mtimeMs < input.maxAgeMs) continue;
      const marker = await readMarker(markerPath);
      await rm(root, { recursive: true, force: false });
      removed.push(root);
      void marker;
    } catch {
      // Unmarked, malformed, or concurrently removed directories are not safe deletion targets.
    }
  }
  return removed;
}

async function assertPrivateTempMarker(temp: PrivateRunTemp): Promise<void> {
  const root = path.resolve(temp.root);
  const markerPath = path.resolve(temp.markerPath);
  if (
    path.basename(root).startsWith(PRIVATE_TEMP_PREFIX) === false ||
    markerPath !== path.join(root, PRIVATE_TEMP_MARKER)
  ) {
    throw new RuntimePrivateTempError("Private temp target is not product-owned.");
  }
  try {
    if (!(await lstat(root)).isDirectory() || !(await lstat(markerPath)).isFile()) {
      throw new RuntimePrivateTempError();
    }
    const marker = await readMarker(markerPath);
    if (marker.runId !== temp.runId || marker.markerId !== temp.markerId) {
      throw new RuntimePrivateTempError("Private temp marker does not match the requested Run.");
    }
  } catch (error) {
    if (error instanceof RuntimePrivateTempError) throw error;
    throw new RuntimePrivateTempError();
  }
}

async function readMarker(markerPath: string): Promise<{
  readonly schemaVersion: 1;
  readonly marker: typeof PRIVATE_TEMP_MARKER_VALUE;
  readonly markerId: string;
  readonly runId: string;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new RuntimePrivateTempError("Private temp marker is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimePrivateTempError();
  }
  const marker = parsed as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.marker !== PRIVATE_TEMP_MARKER_VALUE ||
    typeof marker.markerId !== "string" ||
    typeof marker.runId !== "string"
  ) {
    throw new RuntimePrivateTempError();
  }
  return marker as {
    readonly schemaVersion: 1;
    readonly marker: typeof PRIVATE_TEMP_MARKER_VALUE;
    readonly markerId: string;
    readonly runId: string;
  };
}
