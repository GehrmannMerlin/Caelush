import { Box, Text } from "ink";
import type { CliTimelineState } from "../application/timeline-model.js";

export function CurrentPlan({ plan }: { readonly plan: CliTimelineState["currentPlan"] }) {
  if (plan === undefined || plan.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Plan
      </Text>
      {plan.map((item) => (
        <Text key={item.id}>
          {planMarker(item.status)} {item.title}
        </Text>
      ))}
    </Box>
  );
}

function planMarker(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "IN_PROGRESS":
      return "›";
    case "FAILED":
      return "×";
    case "SKIPPED":
      return "–";
    default:
      return "○";
  }
}
