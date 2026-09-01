import { Static, Text } from "ink";
import type { CliDisplayHistoryEntry } from "../application/cli-state.js";
import type { CliTimelineEntry } from "../application/timeline-model.js";

export function History({ entries }: { readonly entries: readonly CliDisplayHistoryEntry[] }) {
  return (
    <Static items={[...entries]}>
      {(entry) => <Text key={entry.id}>{formatEntry(entry)}</Text>}
    </Static>
  );
}

function formatEntry(entry: CliDisplayHistoryEntry): string {
  if (entry.kind === "USER") return `You: ${entry.text}`;
  if (entry.kind === "ASSISTANT") return `Caelush: ${entry.text}`;
  if (entry.kind === "RUN_TERMINAL") return `Run: ${entry.text}`;
  const timeline = entry as CliTimelineEntry;
  const status = timeline.status === undefined ? "" : ` [${timeline.status.toLowerCase()}]`;
  return `${timeline.title}${status}: ${timeline.text}`;
}
