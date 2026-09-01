import { Static, Text } from "ink";
import type { CliTranscriptEntry } from "../application/cli-state.js";

export function Transcript({ entries }: { readonly entries: readonly CliTranscriptEntry[] }) {
  return (
    <Static items={[...entries]}>
      {(entry) => <Text key={entry.id}>{formatEntry(entry)}</Text>}
    </Static>
  );
}

function formatEntry(entry: CliTranscriptEntry): string {
  switch (entry.kind) {
    case "USER":
      return `You: ${entry.text}`;
    case "ASSISTANT":
      return `Caelush: ${entry.text}`;
    case "RUN_TERMINAL":
      return `Run: ${entry.text}`;
  }
}
