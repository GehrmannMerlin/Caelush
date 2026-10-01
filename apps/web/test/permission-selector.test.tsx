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
  it("renders concise Chinese permission names without status suffixes", () => {
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
    expect(html).not.toContain("部分受限执行");
    expect(html).not.toContain("已启用");
    expect(html).not.toContain("Agent 权限");
    expect(html).toContain('aria-label="选择权限"');
  });

  it("renders an explicit empty option when no permission is selected", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={[
          { ...presets[0]!, status: "UNAVAILABLE" },
          { ...presets[1]!, status: "PREPARATION_REQUIRED" },
          presets[2]!,
        ]}
        selected={undefined}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('<option value="" selected="">请选择权限</option>');
    expect(html).toContain('<option value="VIEW_ONLY" disabled="">仅可查看</option>');
    expect(html).toContain(
      '<option value="WORKSPACE_WRITE" disabled="">工作区内修改</option>',
    );
    expect(html).not.toContain('<option value="FULL_ACCESS" selected="">');
  });

  it("keeps the only-Full-Access state empty until confirmation is deliberately opened", () => {
    const onlyFullAccess = [presets[2]!] as const;
    const initialHtml = renderToStaticMarkup(
      <PermissionSelector
        presets={onlyFullAccess}
        selected={undefined}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );
    const confirmationHtml = renderToStaticMarkup(
      <PermissionSelector
        presets={onlyFullAccess}
        selected={{ id: "FULL_ACCESS", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
        confirmationOpen
      />,
    );

    expect(initialHtml).toContain('<option value="" selected="">请选择权限</option>');
    expect(initialHtml).not.toContain("确认使用完全权限");
    expect(confirmationHtml).toContain("确认使用完全权限");
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
