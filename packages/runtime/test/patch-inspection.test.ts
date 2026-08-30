import { describe, expect, it } from "vitest";
import { inspectPatchTargets } from "../src/index.js";

describe("pure patch inspection", () => {
  it("projects parsed patch operations into security resource targets", () => {
    const targets = inspectPatchTargets(`*** Begin Patch
*** Add File: src/created.ts
+created
*** Update File: src/updated.ts
@@
 old
-old
+new
*** Update File: src/source.ts
*** Move to: src/destination.ts
*** Delete File: .env
*** End Patch`);

    expect(targets).toEqual([
      { operation: "WRITE", path: "src/created.ts" },
      { operation: "WRITE", path: "src/updated.ts" },
      { operation: "MOVE", path: "src/source.ts", fromPath: "src/source.ts", toPath: "src/destination.ts" },
      { operation: "DELETE", path: ".env" },
    ]);
  });

  it("keeps parser path safety errors fail-closed", () => {
    expect(() => inspectPatchTargets(`*** Begin Patch
*** Delete File: ../outside.txt
*** End Patch`)).toThrow();
  });
});
