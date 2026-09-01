import { Box, Text } from "ink";
import type { SessionCandidate } from "../application/session-resume.js";

export interface SessionPickerProps {
  readonly candidates: readonly SessionCandidate[];
  readonly selectedIndex: number;
}

export function SessionPicker({ candidates, selectedIndex }: SessionPickerProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan">Resume a Session</Text>
      {candidates.length === 0 ? <Text>No Sessions found in this workspace.</Text> : null}
      {candidates.map((candidate, index) => {
        const title = sessionTitle(candidate);
        return (
          <Text key={candidate.session.id} {...(index === selectedIndex ? { color: "cyan" } : {})}>
            {index === selectedIndex ? "› " : "  "}
            {title} · {shortId(candidate.session.id)} · {formatActivity(candidate.lastActivityAt)}
          </Text>
        );
      })}
      <Text color="gray">↑/↓ select · Enter resume · Esc exit</Text>
    </Box>
  );
}

function sessionTitle(candidate: SessionCandidate): string {
  const value = candidate.session.metadata.title;
  return typeof value === "string" && value.length > 0 ? bound(value, 80) : "Untitled Session";
}

function shortId(id: string): string {
  return id.slice(-8);
}

function formatActivity(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "activity unknown" : date.toISOString();
}

function bound(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
