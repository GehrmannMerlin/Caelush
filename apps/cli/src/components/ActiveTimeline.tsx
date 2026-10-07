import { Box, Text } from "ink";
import type { LiveActivityState } from "@caelush/client";
import type { CliTimelineState } from "../application/timeline-model.js";
import { ActiveProcesses } from "./ActiveProcesses.js";
import { CurrentPlan } from "./CurrentPlan.js";
import { VerificationActivity } from "./VerificationActivity.js";

export function ActiveTimeline({
  timeline,
  liveActivity,
}: {
  readonly timeline: CliTimelineState;
  readonly liveActivity: LiveActivityState;
}) {
  const hasActivity =
    timeline.activeTools.length > 0 ||
    timeline.activeApprovals.length > 0 ||
    timeline.retries.length > 0 ||
    timeline.currentPlan !== undefined ||
    timeline.verification.length > 0 ||
    timeline.activeProcesses.length > 0 ||
    timeline.error !== undefined ||
    liveActivity.activities.length > 0;
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
      {liveActivity.activities.map((activity) => (
        <Text key={activity.id}>
          •{" "}
          {activity.kind === "TOOL_PREPARATION"
            ? activity.text
            : `${liveActivityLabel(activity.kind, activity.phase)}: ${activity.text}`}
          {` · ${liveActivityStatusLabel(activity.status)}`}
        </Text>
      ))}
      {timeline.error === undefined ? null : <Text color="yellow">• {timeline.error}</Text>}
    </Box>
  );
}

function liveActivityStatusLabel(
  status: LiveActivityState["activities"][number]["status"],
): string {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
  }
}

function liveActivityLabel(
  kind: LiveActivityState["activities"][number]["kind"],
  phase: LiveActivityState["activities"][number]["phase"],
): string {
  switch (kind) {
    case "MODEL_TEXT":
      return phase === "COMMENTARY"
        ? "Progress"
        : phase === "FINAL_ANSWER"
          ? "Answer"
          : "Assistant text";
    case "MODEL_REASONING":
      return "Reasoning";
    case "TOOL_PREPARATION":
      return "Tool preparation";
    case "TOOL_ACTIVITY":
      return "Tool activity";
    case "TOOL_OUTPUT":
      return "Tool output";
    case "SHELL_OUTPUT":
      return "Shell output";
    case "PROCESS_OUTPUT":
      return "Process output";
  }
}
