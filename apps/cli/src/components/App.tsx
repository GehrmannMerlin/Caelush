import { Box, useApp, useInput } from "ink";
import { useCallback, useSyncExternalStore } from "react";
import type { CliConversationController } from "../application/cli-controller.js";
import { ActiveTimeline } from "./ActiveTimeline.js";
import { ActivityStatus } from "./ActivityStatus.js";
import { Composer } from "./Composer.js";
import { FatalError } from "./FatalError.js";
import { Header } from "./Header.js";
import { History } from "./History.js";

export interface AppProps {
  readonly controller: CliConversationController;
  readonly writeMessage?: (message: string) => void;
}

export function App({ controller, writeMessage = defaultWriteMessage }: AppProps) {
  const subscribe = useCallback(
    (listener: Parameters<CliConversationController["subscribe"]>[0]) =>
      controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { exit } = useApp();

  useInput(
    (input, key) => {
      if (!key.ctrl || (input !== "c" && input !== "d")) return;
      if (state.activeRun === undefined) {
        exit();
        return;
      }
      writeMessage("The active Run continues in the local daemon.\n");
      exit();
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header state={state} />
      <History entries={state.displayHistory} />
      <ActiveTimeline timeline={state.timeline} />
      <ActivityStatus activity={state.activity} />
      {state.fatalError === undefined ? (
        <Composer
          enabled={state.composerEnabled}
          onSubmit={(value) => controller.submitPrompt(value)}
        />
      ) : (
        <FatalError message={state.fatalError} />
      )}
    </Box>
  );
}

function defaultWriteMessage(message: string): void {
  console.error(message.trim());
}
