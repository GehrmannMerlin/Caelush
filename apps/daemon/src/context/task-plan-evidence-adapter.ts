import type { AgentConversationSnapshot, StoredAgentMessage } from "@caelush/agent";
import {
  aggregateTaskPlanEvidenceState,
  projectProcessOutcome,
  resolveTaskPlanEvidence,
  type ResolvedTaskPlanEvidence,
  type TaskPlanAvailableEvidenceRef,
  type TaskPlanEvidenceFact,
  type TaskPlanEvidenceIdentity,
  type TaskPlanEvidenceState,
} from "@caelush/coding-agent";
import type { AgentRun, RunId, VerificationCheck, VerificationPlan } from "@caelush/protocol";
import type { CaelushStorage } from "@caelush/storage";

const MAX_EVIDENCE_REFS = 24;
const MAX_CLAIMED_REFS = 80;

export interface TaskPlanEvidenceResolverPort {
  resolve(input: {
    readonly identity: TaskPlanEvidenceIdentity;
    readonly planRevision: string;
    readonly refs: readonly string[];
    readonly conversation: AgentConversationSnapshot;
  }): Promise<readonly ResolvedTaskPlanEvidence[]>;
  available(input: {
    readonly identity: TaskPlanEvidenceIdentity;
    readonly conversation: AgentConversationSnapshot;
  }): Promise<readonly TaskPlanAvailableEvidenceRef[]>;
}

/** Read-only adapter that binds model references to the current durable Run and Session. */
export function createTaskPlanEvidenceResolver(input: {
  readonly storage: Pick<
    CaelushStorage,
    "runs" | "messageRecords" | "observations" | "toolInvocations" | "verification"
  >;
}): TaskPlanEvidenceResolverPort {
  return Object.freeze({
    async resolve(request: Parameters<TaskPlanEvidenceResolverPort["resolve"]>[0]) {
      const [run, records, invocations, observations, plans] = await Promise.all([
        input.storage.runs.get(request.identity.runId as RunId),
        input.storage.messageRecords.listByRun(request.identity.runId as RunId),
        input.storage.toolInvocations.listByRun(request.identity.runId as RunId),
        input.storage.observations.listByRun(request.identity.runId as RunId),
        input.storage.verification.listPlans(request.identity.runId as RunId),
      ]);
      const messages = conversationMessages(request.conversation, request.identity);
      const facts = await factsForReferences({
        storage: input.storage,
        identity: request.identity,
        run,
        records,
        messages,
        invocations,
        observations,
        plans,
        refs: request.refs.slice(0, MAX_CLAIMED_REFS),
      });
      return resolveTaskPlanEvidence({
        identity: request.identity,
        refs: request.refs.slice(0, MAX_CLAIMED_REFS),
        facts,
      });
    },
    async available(request: Parameters<TaskPlanEvidenceResolverPort["available"]>[0]) {
      const [run, observations, invocations, plans] = await Promise.all([
        input.storage.runs.get(request.identity.runId as RunId),
        input.storage.observations.listByRun(request.identity.runId as RunId),
        input.storage.toolInvocations.listByRun(request.identity.runId as RunId),
        input.storage.verification.listPlans(request.identity.runId as RunId),
      ]);
      if (run === null || run.sessionId !== request.identity.sessionId) return [];
      const messages = conversationMessages(request.conversation, request.identity);
      const refs = new Map<string, string>();
      /*
       * Only references an independent check can speak about: observations and verification checks.
       *
       * The newest messages used to be offered here as `message:<id>`, and that was wrong twice. A
       * sliding window over the conversation rewrites this list on every Step, so the 1.5 KiB evidence
       * Section changed on every Step for a set that had not become more informative; and a
       * `message:` reference resolves to UNVERIFIED by construction, so citing one can never prove
       * anything. A plan that cites only messages would read as "unchecked" no matter how much work
       * it did. The plan may still cite a message it recorded itself — that is the plan's claim, and
       * it stays printed as unverified — but the host does not recommend one.
       */
      const messageByObservation = observationMessages(messages);
      for (const observation of observations.slice(-MAX_EVIDENCE_REFS)) {
        if (
          observation.kind === "TOOL" &&
          observation.runId === request.identity.runId &&
          messageByObservation.has(observation.id)
        ) {
          const invocation = invocations.find((item) => item.id === observation.toolInvocationId);
          const outcome = projectProcessOutcome(observation.details);
          /*
           * A reference that can only ever resolve to "unchecked" is not evidence to recommend.
           *
           * A process observation carries an outcome and an error carries a fact; a file read, a patch
           * or a plan update carries neither, so citing one can never prove anything and prints as
           * `UNKNOWN` however many times it is cited. Offering those taught the model to cite its own
           * bookkeeping. The tail window is also why this list used to change on every Step: it moved
           * whenever any Tool ran. It now moves when something with an outcome happens.
           */
          if (outcome.kind === "UNKNOWN" && !observation.isError) continue;
          const label = `Tool ${invocation?.toolName ?? "unknown"}; outcome=${outcome.kind}${observation.isError ? "; isError=true" : ""}`;
          refs.set(`observation:${observation.id}`, label);
        }
      }
      const checks = plans
        .flatMap((plan) => plan.checks.map((check) => ({ plan, check })))
        .sort(
          (left, right) =>
            checkTime(left.check) - checkTime(right.check) ||
            compareStrings(left.check.id, right.check.id),
        );
      for (const item of checks.slice(-MAX_EVIDENCE_REFS)) {
        refs.set(
          `verification:${item.check.id}`,
          `${item.check.spec.purpose.toLowerCase()} verification ${item.check.status.toLowerCase()}`,
        );
      }
      return Object.freeze(
        [...refs.entries()]
          .slice(-MAX_EVIDENCE_REFS)
          .map(([reference, description]) => Object.freeze({ reference, description })),
      );
    },
  });
}

export function summarizeTaskPlanEvidence(
  refs: readonly string[],
  evidence: readonly ResolvedTaskPlanEvidence[],
): ReadonlyMap<string, TaskPlanEvidenceState> {
  const states = new Map(evidence.map((item) => [item.reference, item.state] as const));
  return new Map(
    refs.map((reference) => [reference, aggregateTaskPlanEvidenceState([reference], states)]),
  );
}

async function factsForReferences(input: {
  readonly storage: Pick<
    CaelushStorage,
    "runs" | "messageRecords" | "observations" | "toolInvocations" | "verification"
  >;
  readonly identity: TaskPlanEvidenceIdentity;
  readonly run: AgentRun | null;
  readonly records: Awaited<ReturnType<CaelushStorage["messageRecords"]["listByRun"]>>;
  readonly messages: readonly StoredAgentMessage[];
  readonly invocations: Awaited<ReturnType<CaelushStorage["toolInvocations"]["listByRun"]>>;
  readonly observations: Awaited<ReturnType<CaelushStorage["observations"]["listByRun"]>>;
  readonly plans: readonly VerificationPlan[];
  readonly refs: readonly string[];
}): Promise<readonly TaskPlanEvidenceFact[]> {
  if (
    input.run === null ||
    input.run.id !== input.identity.runId ||
    input.run.sessionId !== input.identity.sessionId
  ) {
    return [];
  }
  const resultByObservation = observationMessages(input.messages);
  const facts: TaskPlanEvidenceFact[] = [];
  for (const reference of unique(input.refs)) {
    const parsed = parseReference(reference);
    if (parsed === undefined) continue;
    if (parsed.kind === "MESSAGE") {
      const storedMessage = input.messages.find((item) => item.message.id === parsed.id);
      if (storedMessage === undefined) continue;
      const message = storedMessage.message;
      const record = input.records.find((item) => item.messageId === parsed.id);
      if (record === undefined || record.sessionId !== input.identity.sessionId) continue;
      const toolResult = message.type === "TOOL_RESULT" ? message : undefined;
      const observationId =
        toolResult?.observation.kind === "OBSERVATION"
          ? toolResult.observation.observationId
          : undefined;
      if (toolResult !== undefined && observationId !== undefined) {
        const observation = input.observations.find((item) => item.id === observationId);
        const invocation =
          observation?.kind === "TOOL"
            ? input.invocations.find((item) => item.id === observation.toolInvocationId)
            : undefined;
        if (
          observation?.kind !== "TOOL" ||
          invocation === undefined ||
          observation.runId !== input.identity.runId ||
          invocation.runId !== input.identity.runId ||
          invocation.stepId !== toolResult.sourceStepId ||
          toolResult.toolName !== invocation.toolName ||
          (invocation.externalCallId !== undefined &&
            toolResult.toolCallId !== invocation.externalCallId)
        ) {
          continue;
        }
      }
      facts.push({
        reference,
        kind: "MESSAGE",
        sessionId: record.sessionId,
        runId: record.runId,
        ...(record.sourceStepId === undefined ? {} : { sourceStepId: record.sourceStepId }),
        observedAt: record.createdAt,
        outcome: "UNVERIFIED",
        dependenciesKnown: false,
        mutationWatermark: 0,
      });
      continue;
    }
    if (parsed.kind === "OBSERVATION") {
      const observation = input.observations.find((item) => item.id === parsed.id);
      if (observation?.kind !== "TOOL") continue;
      const invocation = input.invocations.find((item) => item.id === observation.toolInvocationId);
      const associated = resultByObservation.get(observation.id);
      if (
        invocation === undefined ||
        associated === undefined ||
        invocation.runId !== input.identity.runId ||
        invocation.stepId !== observation.stepId ||
        associated.runId !== observation.runId ||
        associated.sourceStepId !== observation.stepId ||
        associated.toolName !== invocation.toolName ||
        (invocation.externalCallId !== undefined &&
          associated.toolCallId !== invocation.externalCallId)
      ) {
        continue;
      }
      const processOutcome = projectProcessOutcome(observation.details);
      const outcome =
        observation.isError || invocation.status === "FAILED"
          ? "TOOL_FAILED"
          : processOutcome.kind === "RUNNING"
            ? "RUNNING"
            : processOutcome.kind === "EXITED_NONZERO" || processOutcome.kind === "TERMINATED"
              ? processOutcome.kind
              : "UNVERIFIED";
      const details = observation.details as Record<string, unknown> | undefined;
      facts.push({
        reference,
        kind: "OBSERVATION",
        sessionId: input.identity.sessionId,
        runId: observation.runId,
        sourceStepId: observation.stepId,
        sourceCallId: associated.toolCallId,
        observedAt: observation.createdAt,
        outcome,
        ...(typeof details?.["omittedBytes"] === "number" && details["omittedBytes"] > 0
          ? { truncated: true }
          : {}),
        dependenciesKnown: false,
        mutationWatermark: mutationWatermark(input.invocations, input.observations),
      });
      continue;
    }

    const matched = input.plans.flatMap((plan) =>
      plan.checks.filter((check) => check.id === parsed.id).map((check) => ({ plan, check })),
    )[0];
    if (matched === undefined || matched.plan.runId !== input.identity.runId) continue;
    const check = matched.check;
    const latest = latestForDomain(input.plans, check);
    const state =
      latest.check.id !== check.id && latest.check.status === "FAILED"
        ? "CHECK_FAILED"
        : latest.check.id !== check.id && latest.check.status === "PASSED"
          ? "CHECK_PASSED"
          : check.status === "PASSED"
            ? "CHECK_PASSED"
            : check.status === "FAILED" || check.status === "ERROR"
              ? "CHECK_FAILED"
              : check.status === "RUNNING" || check.status === "PENDING"
                ? "CHECK_RUNNING"
                : "UNKNOWN";
    const evidenceRows = await input.storage.verification.listEvidence(matched.plan.id, check.id);
    const complete = state !== "CHECK_PASSED" || evidenceRows.length > 0;
    const dependency = check.spec.kind === "PROJECT" ? check.spec.packageRelativePath : undefined;
    const mutations = mutationsAfter({
      invocations: input.invocations,
      observations: input.observations,
      after: check.finishedAt ?? check.createdAt,
    });
    facts.push({
      reference,
      kind: "VERIFICATION",
      sessionId: input.identity.sessionId,
      runId: matched.plan.runId,
      sourceStepId: matched.plan.sourceStepId,
      observedAt: check.finishedAt ?? check.createdAt,
      outcome: complete ? state : "CHECK_INCOMPLETE",
      dependenciesKnown: dependency !== undefined,
      ...(dependency === undefined ? {} : { dependencies: [dependency] }),
      laterMutations: mutations,
      mutationWatermark: mutationWatermark(input.invocations, input.observations),
      ...(latest.check.id === check.id ? {} : { superseded: true }),
    });
  }
  return Object.freeze(facts);
}

function conversationMessages(
  conversation: AgentConversationSnapshot,
  identity: TaskPlanEvidenceIdentity,
): readonly StoredAgentMessage[] {
  if (
    conversation.sessionId !== identity.sessionId ||
    conversation.currentRunId !== identity.runId
  ) {
    return [];
  }
  return conversation.turns
    .filter((turn) => turn.runId === identity.runId && turn.sessionId === identity.sessionId)
    .flatMap((turn) => turn.messages)
    .filter(
      (stored) =>
        stored.message.runId === identity.runId && stored.message.sessionId === identity.sessionId,
    );
}

function observationMessages(
  messages: readonly StoredAgentMessage[],
): ReadonlyMap<string, Extract<StoredAgentMessage["message"], { type: "TOOL_RESULT" }>> {
  const result = new Map<string, Extract<StoredAgentMessage["message"], { type: "TOOL_RESULT" }>>();
  for (const stored of messages) {
    if (
      stored.message.type === "TOOL_RESULT" &&
      stored.message.observation.kind === "OBSERVATION"
    ) {
      result.set(stored.message.observation.observationId, stored.message);
    }
  }
  return result;
}

function parseReference(
  reference: string,
): { readonly kind: "MESSAGE" | "OBSERVATION" | "VERIFICATION"; readonly id: string } | undefined {
  const match = /^(message|observation|verification):([A-Za-z0-9._-]{1,128})$/u.exec(reference);
  if (match?.[1] === "message") return { kind: "MESSAGE", id: match[2]! };
  if (match?.[1] === "observation") return { kind: "OBSERVATION", id: match[2]! };
  if (match?.[1] === "verification") return { kind: "VERIFICATION", id: match[2]! };
  return undefined;
}

function latestForDomain(plans: readonly VerificationPlan[], target: VerificationCheck) {
  const sameDomain = plans.flatMap((plan) =>
    plan.checks
      .filter((check) => sameVerificationDomain(check, target))
      .map((check) => ({ plan, check })),
  );
  return (
    sameDomain
      .sort(
        (left, right) =>
          checkTime(left.check) - checkTime(right.check) ||
          compareStrings(left.check.id, right.check.id),
      )
      .at(-1) ?? { plan: plans[0]!, check: target }
  );
}

function sameVerificationDomain(left: VerificationCheck, right: VerificationCheck): boolean {
  if (left.spec.kind !== right.spec.kind || left.spec.purpose !== right.spec.purpose) return false;
  return (
    left.spec.kind !== "PROJECT" ||
    right.spec.kind !== "PROJECT" ||
    left.spec.packageRelativePath === right.spec.packageRelativePath
  );
}

function checkTime(check: VerificationCheck): number {
  return check.finishedAt ?? check.startedAt ?? check.createdAt;
}

function mutationsAfter(input: {
  readonly invocations: Awaited<ReturnType<CaelushStorage["toolInvocations"]["listByRun"]>>;
  readonly observations: Awaited<ReturnType<CaelushStorage["observations"]["listByRun"]>>;
  readonly after: number;
}): readonly { readonly at: number; readonly path?: string }[] {
  const observationByInvocation = new Map(
    input.observations
      .filter((observation) => observation.kind === "TOOL")
      .map((observation) => [observation.toolInvocationId, observation] as const),
  );
  const mutations: { at: number; path?: string }[] = [];
  for (const invocation of input.invocations) {
    const at = invocation.finishedAt;
    if (at === undefined || at <= input.after) continue;
    const observation = observationByInvocation.get(invocation.id);
    if (observation === undefined || observation.isError) continue;
    if (invocation.toolName === "apply_patch") {
      const changes = observation.details?.["changes"];
      if (Array.isArray(changes) && changes.length > 0) {
        for (const item of changes) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const change = item as Record<string, unknown>;
          const path =
            typeof change["path"] === "string"
              ? change["path"]
              : typeof change["toPath"] === "string"
                ? change["toPath"]
                : undefined;
          mutations.push({ at, ...(path === undefined ? {} : { path }) });
        }
      } else {
        mutations.push({ at });
      }
    } else if (invocation.toolName === "exec_command" || invocation.toolName === "write_stdin") {
      mutations.push({ at });
    }
  }
  return Object.freeze(mutations);
}

function mutationWatermark(
  invocations: Awaited<ReturnType<CaelushStorage["toolInvocations"]["listByRun"]>>,
  observations: Awaited<ReturnType<CaelushStorage["observations"]["listByRun"]>>,
): number {
  return mutationsAfter({ invocations, observations, after: 0 }).reduce(
    (latest, mutation) => Math.max(latest, mutation.at),
    0,
  );
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].slice(0, MAX_CLAIMED_REFS));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
