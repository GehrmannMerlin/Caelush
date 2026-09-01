import { Box, Text } from "ink";
import type { CliApprovalView } from "../application/cli-control.js";

export interface ApprovalDialogProps {
  readonly approval: CliApprovalView;
  readonly selectedIndex: number;
  readonly submitting: boolean;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

export function ApprovalDialog({
  approval,
  selectedIndex,
  submitting,
}: ApprovalDialogProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{approval.title}</Text>
      <Text>{approval.reason}</Text>
      <Text>Risk: {approval.riskLevel}</Text>
      {approval.toolName === undefined ? null : <Text>Tool: {approval.toolName}</Text>}
      {approval.requiredCapabilities.length === 0 ? null : (
        <Text>Capabilities: {approval.requiredCapabilities.join(", ")}</Text>
      )}
      {approval.summary === undefined ? null : <Text>Summary: {approval.summary}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {approval.options.map((option, index) => (
          <Text key={option.kind} {...(index === selectedIndex ? { color: "cyan" } : {})}>
            {index === selectedIndex ? "› " : "  "}
            {option.label}
          </Text>
        ))}
      </Box>
      <Text color="gray">
        {submitting ? "Resolving approval..." : "↑/↓ select · Enter confirm · Esc close"}
      </Text>
    </Box>
  );
}
