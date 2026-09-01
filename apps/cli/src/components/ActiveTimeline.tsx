import { Box, Text } from "ink";
import type { CliTimelineState } from "../application/timeline-model.js";
import { ActiveProcesses } from "./ActiveProcesses.js";
import { CurrentPlan } from "./CurrentPlan.js";
import { VerificationActivity } from "./VerificationActivity.js";

export function ActiveTimeline({ timeline }: { readonly timeline: CliTimelineState }) {
  const hasActivity =
    timeline.activeTools.length > 0 ||
    timeline.activeApprovals.length > 0 ||
    timeline.retries.length > 0 ||
    timeline.currentPlan !== undefined ||
    timeline.verification.length > 0 ||
    timeline.activeProcesses.length > 0 ||
    timeline.error !== undefined;
  if (!hasActivity) return null;
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color="gray">
        Live activity
      </Text>
      <CurrentPlan plan={timeline.currentPlan} />
      {timeline.activeTools.map((tool) => (
        <Text key={tool.id}>
          • {tool.title}: {tool.text}
        </Text>
      ))}
      {timeline.activeApprovals.map((approval) => (
        <Text key={approval.id} color="yellow">
          • {approval.title}: {approval.text}
        </Text>
      ))}
      {timeline.retries.map((retry) => (
        <Text key={retry.id}>
          • {retry.text}
          {retry.started ? " · started" : ""}
        </Text>
      ))}
      <ActiveProcesses processes={timeline.activeProcesses} />
      <VerificationActivity groups={timeline.verification} />
      {timeline.error === undefined ? null : <Text color="yellow">• {timeline.error}</Text>}
    </Box>
  );
}
