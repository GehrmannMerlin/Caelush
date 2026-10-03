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

  it("renders unprepared workspace write as selectable and visually muted", () => {
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
    expect(html).toContain('<option value="VIEW_ONLY" disabled="">仅可查看（不可用）</option>');
    expect(html).toContain(
      '<option value="WORKSPACE_WRITE" class="permission-selector-option--preparation-required">工作区内修改</option>',
    );
    expect(html).not.toContain("工作区内修改（待准备）");
    expect(html).not.toContain("permission-selector-prepare");
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

  it("explains why restricted presets are unavailable instead of silently disabling them", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={[
          { ...presets[0]!, status: "UNAVAILABLE", reasonCode: "RUNNER_ARTIFACT_MISSING" },
          { ...presets[1]!, status: "UNAVAILABLE", reasonCode: "RUNNER_ARTIFACT_MISSING" },
          presets[2]!,
        ]}
        selected={{ id: "FULL_ACCESS", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('<option value="VIEW_ONLY" disabled="">仅可查看（不可用）</option>');
    expect(html).toContain(
      '<option value="WORKSPACE_WRITE" disabled="">工作区内修改（不可用）</option>',
    );
    expect(html).toContain("仅可查看不可用：未加载 Windows 安全组件");
    expect(html).toContain("工作区内修改不可用：未加载 Windows 安全组件");
    expect(html).toContain("未加载 Windows 安全组件");
  });

  it("keeps each unavailable permission paired with its own reason", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={[
          { ...presets[0]!, status: "UNAVAILABLE", reasonCode: "RUNNER_FUNCTIONAL_PROBE_FAILED" },
          { ...presets[1]!, status: "UNAVAILABLE", reasonCode: "PERMISSION_PRESETS_DISABLED" },
          { ...presets[2]!, status: "UNAVAILABLE", reasonCode: "FULL_ACCESS_DISABLED" },
        ]}
        selected={undefined}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("仅可查看不可用：Windows 安全组件自检失败");
    expect(html).toContain("工作区内修改不可用：权限预设功能已关闭");
    expect(html).toContain("完全权限不可用：完全权限已关闭");
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

  it("keeps the permission selector compact while workspace preparation runs", () => {
    const html = renderToStaticMarkup(
      <PermissionSelector
        presets={[presets[0]!, { ...presets[1]!, status: "PREPARATION_REQUIRED" }, presets[2]!]}
        selected={{ id: "VIEW_ONLY", expectedVersion: 1 }}
        preparing={{ id: "WORKSPACE_WRITE", expectedVersion: 1 }}
        disabled={false}
        onSelect={vi.fn()}
        onPrepare={vi.fn()}
      />,
    );

    expect(html).toContain('<option value="VIEW_ONLY" selected="">仅可查看</option>');
    expect(html).toContain(
      '<option value="WORKSPACE_WRITE" class="permission-selector-option--preparation-required">工作区内修改</option>',
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("当前实际用于新任务");
    expect(html).not.toContain("请求的工作区内修改尚未生效");
    expect(html).not.toContain("（待准备）");
    expect(html).not.toContain("准备工作区修改");
    expect(html).not.toContain("permission-selector-prepare");
  });
});
