import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseThemePreference, type ThemePreference } from "@caelush/ui-theme";

const DOCUMENT_VERSION = 1;
const MAX_DOCUMENT_BYTES = 512;

interface AppearanceDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly preference: ThemePreference;
}

export interface DesktopAppearanceFileOperations {
  readonly rename: (source: string, destination: string) => Promise<void>;
}

const defaultFileOperations: DesktopAppearanceFileOperations = { rename };

export class DesktopAppearanceStore {
  constructor(
    private readonly filePath: string,
    private readonly fileOperations: DesktopAppearanceFileOperations = defaultFileOperations,
  ) {}

  async read(): Promise<ThemePreference> {
    try {
      const value = await readFile(this.filePath);
      if (value.byteLength > MAX_DOCUMENT_BYTES) return "light";
      const document: unknown = JSON.parse(value.toString("utf8"));
      return parseAppearanceDocument(document);
    } catch {
      return "light";
    }
  }

  async write(preference: ThemePreference): Promise<void> {
    const document: AppearanceDocument = {
      version: DOCUMENT_VERSION,
      preference: parseThemePreference(preference),
    };
    const output = JSON.stringify(document);
    if (Buffer.byteLength(output, "utf8") > MAX_DOCUMENT_BYTES) {
      throw new Error("Desktop appearance preference is too large.");
    }

    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, output, { flag: "wx", mode: 0o600 });
      const source = await realpath(temporaryPath);
      const destination = path.join(path.dirname(source), path.basename(this.filePath));
      await this.fileOperations.rename(source, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function parseAppearanceDocument(value: unknown): ThemePreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "light";
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.version !== DOCUMENT_VERSION ||
    !Object.hasOwn(record, "preference")
  ) {
    return "light";
  }
  try {
    return parseThemePreference(record.preference);
  } catch {
    return "light";
  }
}
