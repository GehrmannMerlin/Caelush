import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PermissionSelector } from "../src/components/permission-selector.js";
import type { PermissionPresetViewModel } from "../src/application/permission-presets.js";

const presets: readonly PermissionPresetViewModel[] = [
  {
    id: "VIEW_ONLY",
    version: 1,
    displayName: "仅可查看",
    description: "只读访问。",
    status: "AVAILABLE",
    requiresConfirmation: false,
    sandboxEnforcement: "PARTIAL",
  },
  {
    id: "WORKSPACE_WRITE",
    version: 1,
    displayName: "工作区内修改",
    description: "可以修改当前工作区。",
    status: "AVAILABLE",
    requiresConfirmation: false,
    sandboxEnforcement: "PARTIAL",
  },
  {
    id: "FULL_ACCESS",
    version: 1,
    displayName: "完全权限",
    description: "在硬安全规则内使用主机用户权限。",
    status: "AVAILABLE",
    requiresConfirmation: true,
    sandboxEnforcement: "NONE",
  },
];

describe("PermissionSelector", () => {
  it("renders all server-provided options and partial enforcement wording", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={presets}
        selected={{ id: "WORKSPACE_WRITE", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("仅可查看");
    expect(html).toContain("工作区内修改");
    expect(html).toContain("完全权限");
    expect(html).toContain("部分受限执行");
  });

  it("shows an explicit Full Access confirmation action", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={presets}
        selected={{ id: "FULL_ACCESS", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
        confirmationOpen
      />,
    );

    expect(html).toContain("完全权限会让 Agent 使用主机用户范围");
    expect(html).toContain("确认使用完全权限");
    expect(html).toContain("取消");
  });
});
