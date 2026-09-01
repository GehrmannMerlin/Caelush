import { Box, Text } from "ink";
import type { CliTimelineState } from "../application/timeline-model.js";

export function VerificationActivity({
  groups,
}: {
  readonly groups: CliTimelineState["verification"];
}) {
  if (groups.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        Verification
      </Text>
      {groups.map((group) => (
        <Box key={group.planId} flexDirection="column" paddingLeft={1}>
          <Text>
            {group.passed}/{group.checkCount} passed
            {group.failed > 0 ? ` · ${group.failed} failed` : ""}
            {group.errors > 0 ? ` · ${group.errors} error` : ""}
          </Text>
          {group.checks.map((check) => (
            <Text key={check.checkId}>
              {checkMarker(check.status)} {check.title}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function checkMarker(status: string): string {
  switch (status) {
    case "PASSED":
      return "✓";
    case "FAILED":
    case "ERROR":
      return "×";
    case "CANCELLED":
      return "–";
    default:
      return "…";
  }
}
