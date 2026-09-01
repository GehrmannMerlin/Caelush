import { Box, Text } from "ink";
import type { CliViewState } from "../application/cli-state.js";

export function Header({ state }: { readonly state: CliViewState }) {
  const project =
    state.workspace === undefined ? "workspace unavailable" : truncate(state.workspace.path, 60);
  const model = state.daemonInfo?.defaultModel;
  const modelText = model === undefined ? "model unavailable" : `${model.provider}/${model.model}`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Caelush
      </Text>
      <Text>Project: {project}</Text>
      <Text>Model: {modelText}</Text>
      <Text>Transport: {state.transportState}</Text>
      {state.controlMode === "NONE" ? null : <Text>Control: {state.controlMode}</Text>}
    </Box>
  );
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `…${value.slice(-(limit - 1))}`;
}
