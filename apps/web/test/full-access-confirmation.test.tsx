import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PermissionSelector } from "../src/components/permission-selector.js";

describe("Full Access confirmation", () => {
  it("does not present a silent or implied approval escape hatch", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={[
          {
            id: "FULL_ACCESS",
            version: 1,
            displayName: "完全权限",
            description: "在硬安全规则内使用主机用户权限。",
            status: "AVAILABLE",
            requiresConfirmation: true,
            sandboxEnforcement: "NONE",
          },
        ]}
        selected={{ id: "FULL_ACCESS", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
        confirmationOpen
      />,
    );

    expect(html).toContain("硬安全规则仍然有效");
    expect(html).toContain("确认使用完全权限");
    expect(html).toContain("不会自动批准");
  });
});
