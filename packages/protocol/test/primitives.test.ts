import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): SchemaLike | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as SchemaLike;
}

function getFactory(name: string): (() => string) | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as () => string;
}

describe("protocol primitives", () => {
  it("accepts recursively JSON-safe values and objects", () => {
    const jsonValueSchema = getSchema("JsonValueSchema");
    const jsonObjectSchema = getSchema("JsonObjectSchema");
    if (jsonValueSchema === undefined || jsonObjectSchema === undefined) {
      return;
    }

    expect(jsonValueSchema.parse({ nested: ["text", 42, true, null] })).toEqual({
      nested: ["text", 42, true, null],
    });
    expect(jsonObjectSchema.parse({ answer: 42 })).toEqual({ answer: 42 });
  });

  it("rejects non-JSON values", () => {
    const jsonValueSchema = getSchema("JsonValueSchema");
    if (jsonValueSchema === undefined) {
      return;
    }

    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(new Date(0)).success).toBe(false);
    expect(jsonValueSchema.safeParse(1n).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => "not JSON").success).toBe(false);
  });

  it("accepts nonnegative integer millisecond timestamps only", () => {
    const timestampSchema = getSchema("TimestampMsSchema");
    if (timestampSchema === undefined) {
      return;
    }

    expect(timestampSchema.safeParse(0).success).toBe(true);
    expect(timestampSchema.safeParse(1_700_000_000_000).success).toBe(true);
    expect(timestampSchema.safeParse(-1).success).toBe(false);
    expect(timestampSchema.safeParse(1.5).success).toBe(false);
  });

  it("keeps policy vocabularies fixed and rejects unknown object keys", () => {
    const permissionSchema = getSchema("PermissionProfileSchema");
    const workspaceSchema = getSchema("WorkspaceRefSchema");
    const workspaceIdFactory = getFactory("createWorkspaceId");
    if (
      permissionSchema === undefined ||
      workspaceSchema === undefined ||
      workspaceIdFactory === undefined
    ) {
      return;
    }

    expect(permissionSchema.safeParse("READ_ONLY").success).toBe(true);
    expect(permissionSchema.safeParse("read_only").success).toBe(false);
    expect(
      workspaceSchema.safeParse({ id: workspaceIdFactory(), path: "D:/workspace", typo: true })
        .success,
    ).toBe(false);
  });
});
