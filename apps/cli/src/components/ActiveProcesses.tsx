import { Box, Text } from "ink";
import type { CliTimelineState } from "../application/timeline-model.js";

export function ActiveProcesses({
  processes,
}: {
  readonly processes: CliTimelineState["activeProcesses"];
}) {
  if (processes.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Processes
      </Text>
      {processes.map((process) => (
        <Text key={process.id}>• {process.text}</Text>
      ))}
    </Box>
  );
}
