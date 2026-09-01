import { Text } from "ink";
import type { CliActivity } from "../application/cli-state.js";

export function ActivityStatus({ activity }: { readonly activity: CliActivity }) {
  return (
    <Text color={activity === "Transport error" || activity === "Cancelling" ? "yellow" : "gray"}>
      Status: {activity}
    </Text>
  );
}
