import { Box, Text } from "ink";
import type { ClientAgentRun } from "@caelush/protocol";

export interface RunRecoveryPickerProps {
  readonly candidates: readonly ClientAgentRun[];
  readonly selectedIndex: number;
}

export function RunRecoveryPicker({ candidates, selectedIndex }: RunRecoveryPickerProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Choose a Run to recover</Text>
      {candidates.map((run, index) => (
        <Text key={run.id} {...(index === selectedIndex ? { color: "yellow" } : {})}>
          {index === selectedIndex ? "› " : "  "}
          {run.status} · {shortId(run.id)} · {bound(run.goal, 100)} · {formatTime(run.createdAt)}
        </Text>
      ))}
      <Text color="gray">↑/↓ select · Enter recover · Esc exit</Text>
    </Box>
  );
}

function shortId(id: string): string {
  return id.slice(-8);
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unknown" : date.toISOString();
}

function bound(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
