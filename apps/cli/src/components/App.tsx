import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useSyncExternalStore } from "react";
import type { CliConversationController } from "../application/cli-controller.js";
import { approvalResolutionForOption, routeCliInput } from "../application/cli-control.js";
import { ActiveTimeline } from "./ActiveTimeline.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { ActivityStatus } from "./ActivityStatus.js";
import { Composer } from "./Composer.js";
import { FatalError } from "./FatalError.js";
import { Header } from "./Header.js";
import { History } from "./History.js";
import { RunRecoveryPicker } from "./RunRecoveryPicker.js";
import { SessionPicker } from "./SessionPicker.js";

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
  const selectedApproval = state.approvalState?.requests[state.approvalState.selectedRequestIndex];

  useInput(
    (input, key) => {
      const action = routeCliInput(state, input, key);
      switch (action.kind) {
        case "APPROVAL_MOVE":
          controller.moveApprovalSelection(action.delta);
          return;
        case "APPROVAL_SUBMIT": {
          const approval = state.approvalState?.requests[state.approvalState.selectedRequestIndex];
          if (approval === undefined) return;
          const option = approval.options[approval.selectedIndex];
          if (option === undefined) return;
          void controller.resolveApproval(approval.id, approvalResolutionForOption(option.kind));
          return;
        }
        case "APPROVAL_CLOSE":
          controller.closeApproval();
          return;
        case "SESSION_MOVE":
          controller.moveSessionSelection(action.delta);
          return;
        case "SESSION_SELECT":
          void controller.selectSession(state.sessionSelectionIndex);
          return;
        case "SESSION_CLOSE":
          exit();
          return;
        case "RUN_RECOVERY_MOVE":
          controller.moveRecoverySelection(action.delta);
          return;
        case "RUN_RECOVERY_SELECT":
          void controller.selectRecoveryRun(state.recoverySelectionIndex);
          return;
        case "RUN_RECOVERY_CLOSE":
          exit();
          return;
        case "PENDING_CONFIRM":
          void controller.confirmPendingRun(action.confirmed);
          return;
        case "PENDING_CLOSE":
          controller.closePendingRunConfirmation();
          return;
        case "RECONNECT":
          controller.reconnectActiveRun();
          return;
        case "CANCEL":
          void controller.cancelActiveRun();
          return;
        case "DETACH":
          controller.detachActiveRun();
          writeMessage("The active Run continues in the local daemon.\n");
          exit();
          return;
        case "EXIT":
          exit();
          return;
        case "COMPOSER":
        case "NONE":
          return;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header state={state} />
      <History entries={state.displayHistory} />
      <ActiveTimeline timeline={state.timeline} />
      {state.controlMode === "SESSION_PICKER" ? (
        <SessionPicker
          candidates={state.sessionCandidates}
          selectedIndex={state.sessionSelectionIndex}
        />
      ) : null}
      {state.controlMode === "RUN_RECOVERY_PICKER" ? (
        <RunRecoveryPicker
          candidates={state.recoveryCandidates}
          selectedIndex={state.recoverySelectionIndex}
        />
      ) : null}
      {state.controlMode === "APPROVAL" && selectedApproval !== undefined ? (
        <ApprovalDialog
          approval={selectedApproval}
          selectedIndex={selectedApproval.selectedIndex}
          submitting={state.approvalState?.submitting ?? false}
          onMove={(delta) => controller.moveApprovalSelection(delta)}
          onSubmit={() => {
            const approval =
              state.approvalState?.requests[state.approvalState.selectedRequestIndex];
            const option = approval?.options[approval.selectedIndex];
            if (approval !== undefined && option !== undefined) {
              void controller.resolveApproval(
                approval.id,
                approvalResolutionForOption(option.kind),
              );
            }
          }}
          onClose={() => controller.closeApproval()}
        />
      ) : null}
      {state.notice === undefined ? null : <Text color="yellow">{state.notice}</Text>}
      {state.transportError === undefined ? null : (
        <Text color="yellow">{state.transportError}</Text>
      )}
      {state.controlError === undefined ? null : <Text color="yellow">{state.controlError}</Text>}
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
