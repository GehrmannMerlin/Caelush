import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createInitialLiveActivityState,
  createInitialTimelineState,
  type LiveActivityState,
} from "@caelush/client";
import {
  createRunId,
  createToolInvocationId,
  type ClientAgentRun,
  type SessionTurnPresentationResponseV3,
} from "@caelush/protocol";

import { SessionWorkspace } from "../src/components/session-workspace.js";
import {
  cancelScrollReconciliation,
  scheduleScrollReconciliation,
} from "../src/components/turn-presentation-feed.js";
import type {
  FrameHandle,
  FrameScheduler,
} from "../src/application/frame-publication-scheduler.js";

const runOneId = createRunId();
const runTwoId = createRunId();
const runThreeId = createRunId();
const runFourId = createRunId();

function turnPresentation(): SessionTurnPresentationResponseV3 {
  return {
    capabilityVersion: 3,
    turns: [
      {
        runId: runOneId,
        conversationTurnId: "turn-one",
        runStatus: "COMPLETED",
        openedAt: 1_000,
        closedAt: 3_000,
        highWatermark: 8,
        items: [
          user(runOneId, "turn-one", 0, "任务一"),
          commentary(runOneId, "turn-one", 1, "过程一"),
          final(runOneId, "turn-one", 2, "结果一"),
        ],
      },
      {
        runId: runTwoId,
        conversationTurnId: "turn-two",
        runStatus: "COMPLETED",
        openedAt: 4_000,
        closedAt: 6_000,
        highWatermark: 7,
        items: [
          user(runTwoId, "turn-two", 0, "任务二"),
          commentary(runTwoId, "turn-two", 1, "过程二"),
          final(runTwoId, "turn-two", 2, "结果二"),
        ],
      },
      {
        runId: runThreeId,
        conversationTurnId: "turn-three",
        runStatus: "RUNNING",
        openedAt: 7_000,
        highWatermark: 3,
        items: [
          user(runThreeId, "turn-three", 0, "任务三"),
          commentary(runThreeId, "turn-three", 1, "过程三"),
        ],
      },
    ],
  };
}

function user(
  runId: ReturnType<typeof createRunId>,
  turnId: string,
  ordinal: number,
  text: string,
) {
  return {
    id: `${turnId}:user`,
    runId,
    conversationTurnId: turnId,
    ordinal,
    status: "COMPLETED" as const,
    createdAt: 1_000 + ordinal,
    kind: "USER" as const,
    text,
  };
}

function commentary(
  runId: ReturnType<typeof createRunId>,
  turnId: string,
  ordinal: number,
  text: string,
) {
  return {
    id: `${turnId}:commentary`,
    runId,
    conversationTurnId: turnId,
    ordinal,
    status: "COMPLETED" as const,
    createdAt: 1_001 + ordinal,
    kind: "ASSISTANT" as const,
    phase: "COMMENTARY" as const,
    text,
  };
}

function final(
  runId: ReturnType<typeof createRunId>,
  turnId: string,
  ordinal: number,
  text: string,
) {
  return {
    id: `${turnId}:final`,
    runId,
    conversationTurnId: turnId,
    ordinal,
    status: "COMPLETED" as const,
    createdAt: 1_002 + ordinal,
    kind: "ASSISTANT" as const,
    phase: "FINAL_ANSWER" as const,
    text,
  };
}

function liveToolActivity(runId: ReturnType<typeof createRunId>): LiveActivityState {
  const invocationId = createToolInvocationId();
  return {
    ...createInitialLiveActivityState(runId),
    activities: [
      {
        id: `tool-activity:${invocationId}`,
        kind: "TOOL_ACTIVITY",
        status: "ACTIVE",
        toolPhase: "RUNNING",
        category: "EDIT",
        toolName: "apply_patch",
        title: "编辑文件",
        text: "应用已验证的工作区补丁",
        streamKey: "durable:run",
        streamSequence: 1,
        runId,
        toolInvocationId: invocationId,
      },
    ],
    modelWait: {
      runId,
      phase: "WAITING_PROVIDER",
      lastActivityAt: 7_000,
      idleForMs: 0,
      idleTimeoutMs: 300_000,
      providerEventReceived: false,
      displayableEventReceived: false,
    },
  } as LiveActivityState;
}

describe("SessionConversation V3 rendering", () => {
  it("coalesces near-bottom scroll reconciliation to one frame", () => {
    const scheduler = new TestScrollFrameScheduler();
    const pending: { current: FrameHandle | undefined } = { current: undefined };
    let mounted = true;
    let nearBottom = true;
    let scrollTop = 100;
    let reconciliations = 0;

    for (let update = 0; update < 20; update += 1) {
      scheduleScrollReconciliation(
        scheduler,
        pending,
        () => mounted,
        () => nearBottom,
        () => {
          reconciliations += 1;
          scrollTop = 1_000;
        },
      );
    }

    expect(scheduler.scheduleCount).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.flushNext();
    expect(reconciliations).toBe(1);
    expect(scrollTop).toBe(1_000);
    mounted = false;
  });

  it("keeps the user's scroll position when they move away from the bottom before a frame", () => {
    const scheduler = new TestScrollFrameScheduler();
    const pending: { current: FrameHandle | undefined } = { current: undefined };
    let mounted = true;
    let nearBottom = true;
    let scrollTop = 240;
    let reconciliations = 0;

    scheduleScrollReconciliation(
      scheduler,
      pending,
      () => mounted,
      () => nearBottom,
      () => {
        reconciliations += 1;
        scrollTop = 1_000;
      },
    );
    nearBottom = false;
    scheduler.flushNext();

    expect(reconciliations).toBe(0);
    expect(scrollTop).toBe(240);
    mounted = false;
  });

  it("cancels pending scroll reconciliation on unmount and ignores a stale callback", () => {
    const scheduler = new TestScrollFrameScheduler();
    const pending: { current: FrameHandle | undefined } = { current: undefined };
    let mounted = true;
    let domOperations = 0;

    scheduleScrollReconciliation(
      scheduler,
      pending,
      () => mounted,
      () => true,
      () => (domOperations += 1),
    );
    mounted = false;
    cancelScrollReconciliation(scheduler, pending);
    scheduler.flushStale();

    expect(scheduler.pendingCount).toBe(0);
    expect(pending.current).toBeUndefined();
    expect(domOperations).toBe(0);
  });

  it("renders complete Turns in server order and gives live state only to the active Run", () => {
    const live = liveToolActivity(runThreeId);
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="多轮会话"
        history={[]}
        turnPresentation={turnPresentation()}
        activeRun={{ id: runThreeId, status: "RUNNING" } as ClientAgentRun}
        timeline={createInitialTimelineState(runThreeId)}
        liveActivity={live}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );

    const userOne = html.indexOf("任务一");
    const processOne = html.indexOf("过程一");
    const finalOne = html.indexOf("结果一");
    const userTwo = html.indexOf("任务二");
    const processTwo = html.indexOf("过程二");
    const finalTwo = html.indexOf("结果二");
    const userThree = html.indexOf("任务三");
    const processThree = html.indexOf("过程三");

    expect(userOne).toBeLessThan(processOne);
    expect(processOne).toBeLessThan(finalOne);
    expect(finalOne).toBeLessThan(userTwo);
    expect(userTwo).toBeLessThan(processTwo);
    expect(processTwo).toBeLessThan(finalTwo);
    expect(finalTwo).toBeLessThan(userThree);
    expect(userThree).toBeLessThan(processThree);

    const turnOneMarkup =
      html.match(
        /data-run-id="[^"]+"[^>]*data-conversation-turn-id="turn-one"[\s\S]*?<\/article>/u,
      )?.[0] ?? "";
    const turnTwoMarkup =
      html.match(
        /data-run-id="[^"]+"[^>]*data-conversation-turn-id="turn-two"[\s\S]*?<\/article>/u,
      )?.[0] ?? "";
    const turnThreeStart = html.indexOf('data-conversation-turn-id="turn-three"');
    expect(turnOneMarkup).not.toContain("turn-presentation-live-item");
    expect(turnTwoMarkup).not.toContain("turn-presentation-live-item");
    expect(html.slice(turnThreeStart)).toContain("turn-presentation-live-item");
    expect(html.slice(turnThreeStart)).toContain("正在编辑文件");
    expect(html.slice(turnThreeStart)).toContain("正在等待模型响应");
    expect(html.lastIndexOf("prompt-composer")).toBeGreaterThan(finalTwo);
  });

  it("keeps Final answers outside collapsed Process and safely renders an empty active Turn", () => {
    const presentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [
        {
          runId: runOneId,
          conversationTurnId: "turn-one",
          runStatus: "COMPLETED",
          openedAt: 1_000,
          closedAt: 2_000,
          highWatermark: 1,
          items: [
            user(runOneId, "turn-one", 0, "任务一"),
            final(runOneId, "turn-one", 1, "始终可见"),
          ],
        },
        {
          runId: runTwoId,
          conversationTurnId: "turn-two",
          runStatus: "RUNNING",
          openedAt: 3_000,
          highWatermark: 0,
          items: [],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="空 Turn"
        history={[]}
        turnPresentation={presentation}
        activeRun={{ id: runTwoId, status: "RUNNING" } as ClientAgentRun}
        timeline={createInitialTimelineState(runTwoId)}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );

    expect(html).toContain("始终可见");
    expect(html).toContain('data-conversation-turn-id="turn-two"');
    expect(html).toContain("正在启动任务");
    expect(html.indexOf("始终可见")).toBeLessThan(
      html.indexOf('data-conversation-turn-id="turn-two"'),
    );
  });

  it("retains a completed File effect inside a Turn that later failed", () => {
    const invocationId = createToolInvocationId();
    const failedTurn: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [
        {
          runId: runOneId,
          conversationTurnId: "failed-turn",
          runStatus: "FAILED",
          openedAt: 1_000,
          closedAt: 4_000,
          highWatermark: 9,
          items: [
            user(runOneId, "failed-turn", 0, "完成补丁后继续验证"),
            {
              id: "completed-file-change",
              runId: runOneId,
              conversationTurnId: "failed-turn",
              ordinal: 1,
              status: "COMPLETED",
              createdAt: 2_000,
              kind: "TOOL",
              toolInvocationId: invocationId,
              toolName: "apply_patch",
              category: "EDIT",
              phase: "COMPLETED",
              title: "编辑文件",
              summary: "补丁已应用",
              facts: [],
              effects: [
                {
                  type: "FILE_CHANGE",
                  path: "login.html",
                  changeType: "CREATED",
                  additions: 214,
                  deletions: 0,
                },
              ],
            },
            {
              id: "failed-run-summary",
              runId: runOneId,
              conversationTurnId: "failed-turn",
              ordinal: 2,
              status: "FAILED",
              createdAt: 4_000,
              kind: "RUN_SUMMARY",
              runStatus: "FAILED",
              text: "后续任务失败，文件修改仍已发生。",
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="失败后保留副作用"
        history={[]}
        turnPresentation={failedTurn}
        timeline={createInitialTimelineState()}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );

    const userIndex = html.indexOf("完成补丁后继续验证");
    const toolIndex = html.indexOf("login.html");
    const failureIndex = html.indexOf("后续任务失败，文件修改仍已发生。");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(userIndex);
    expect(failureIndex).toBeGreaterThan(userIndex);
    expect(html).toContain("新建");
    expect(html).toContain("+214");
    expect(html).toContain('data-run-status="FAILED"');
  });

  it("places an optimistic user after durable Turns and reconciles it when its Run Turn arrives", () => {
    const optimisticUser = {
      id: `optimistic:user:${runFourId}`,
      runId: runFourId,
      conversationTurnId: runFourId,
      createdAt: 8_000,
      kind: "USER" as const,
      text: "下一项任务",
    };
    const durableTranscriptUser = { ...optimisticUser, id: "durable:user:turn-four" };
    const base = turnPresentation();
    const beforeRefresh = renderToStaticMarkup(
      <SessionWorkspace
        title="乐观放置"
        history={[optimisticUser]}
        turnPresentation={{ capabilityVersion: 3, turns: base.turns.slice(0, 2) }}
        timeline={createInitialTimelineState()}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );
    expect(beforeRefresh.indexOf("结果二")).toBeLessThan(beforeRefresh.indexOf("下一项任务"));
    expect(beforeRefresh.match(/下一项任务/gu)).toHaveLength(1);
    expect(beforeRefresh).toContain('data-optimistic-run="true"');

    const transcriptAheadOfPresentation = renderToStaticMarkup(
      <SessionWorkspace
        title="Transcript 先于 Presentation"
        history={[durableTranscriptUser]}
        turnPresentation={{ capabilityVersion: 3, turns: base.turns.slice(0, 2) }}
        activeRun={{ id: runFourId, status: "RUNNING" } as ClientAgentRun}
        timeline={createInitialTimelineState(runFourId)}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );
    expect(transcriptAheadOfPresentation.indexOf("结果二")).toBeLessThan(
      transcriptAheadOfPresentation.indexOf("下一项任务"),
    );
    expect(transcriptAheadOfPresentation.match(/下一项任务/gu)).toHaveLength(1);

    const afterRefresh = renderToStaticMarkup(
      <SessionWorkspace
        title="乐观放置"
        history={[durableTranscriptUser]}
        turnPresentation={{
          capabilityVersion: 3,
          turns: [
            ...base.turns.slice(0, 2),
            {
              runId: runFourId,
              conversationTurnId: "turn-four",
              runStatus: "RUNNING",
              openedAt: 8_000,
              highWatermark: 0,
              items: [],
            },
          ],
        }}
        activeRun={{ id: runFourId, status: "RUNNING" } as ClientAgentRun}
        timeline={createInitialTimelineState(runFourId)}
        composer={<footer className="prompt-composer">输入</footer>}
      />,
    );
    expect(afterRefresh.match(/下一项任务/gu)).toHaveLength(1);
    expect(afterRefresh).toContain('data-conversation-turn-id="turn-four"');
    expect(afterRefresh.indexOf("结果二")).toBeLessThan(afterRefresh.indexOf("下一项任务"));
  });
});

class TestScrollFrameScheduler implements FrameScheduler {
  private nextHandleId = 0;
  private readonly callbacks: Array<{
    readonly handle: FrameHandle;
    readonly callback: () => void;
    cancelled: boolean;
    flushed: boolean;
    staleFlushed: boolean;
  }> = [];
  scheduleCount = 0;

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled && !item.flushed).length;
  }

  schedule(callback: () => void): FrameHandle {
    const handle = { id: this.nextHandleId++ };
    this.callbacks.push({
      handle,
      callback,
      cancelled: false,
      flushed: false,
      staleFlushed: false,
    });
    this.scheduleCount += 1;
    return handle;
  }

  cancel(handle: FrameHandle): void {
    const callback = this.callbacks.find((item) => item.handle === handle);
    if (callback !== undefined) callback.cancelled = true;
  }

  flushNext(): void {
    const callback = this.callbacks.find((item) => !item.cancelled && !item.flushed);
    if (callback === undefined) throw new Error("No pending scroll frame callback to flush.");
    callback.flushed = true;
    callback.callback();
  }

  flushStale(): void {
    for (const callback of this.callbacks) {
      if (callback.cancelled && !callback.staleFlushed) {
        callback.staleFlushed = true;
        callback.callback();
      }
    }
  }
}
