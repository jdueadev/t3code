import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type ProjectId,
  type ServerProvider,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import { chooseUsageLimitFallback, usageLimitRouteMessage } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/** `wait` and `auto-route` resume at the reset whatever the auto-resume switch says. */
export function limitAutoResume(
  settings: Pick<ServerSettingsShape, "autoResumeLimitedThreads" | "usageLimitRouting">,
): boolean {
  return settings.autoResumeLimitedThreads || settings.usageLimitRouting.onLimit !== "ask";
}

const ROUTE_MESSAGE_PREFIX = "limit-route:";

/**
 * With `auto-route`, continues a limited run on the first eligible fallback while its own
 * model is still out of quota. Models the same limit chain already ran on are skipped, so a
 * chain ends after the list instead of bouncing between spent models. Null means wait.
 */
export function limitRouteCommand(input: {
  readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "modelSelection" | "userMessageId">>;
  readonly settings: ServerSettingsShape;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly hubOrigins: ReadonlyArray<string>;
  readonly projectId: ProjectId | null;
  readonly nowMs: number;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread } = input;
  if (
    input.settings.usageLimitRouting.onLimit !== "auto-route" ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  // Past the reset the original model has quota again, so it resumes instead.
  const resetMs = thread.usageLimitResetAt == null ? NaN : Date.parse(thread.usageLimitResetAt);
  if (Number.isFinite(resetMs) && resetMs <= input.nowMs) return null;
  const failed = input.runs.find((run) => run.id === thread.latestRunId);
  if (failed === undefined) return null;
  // A routed run's message id names the run it continued, which links the chain.
  const tried: Array<ModelSelection> = [];
  for (
    let run: (typeof input.runs)[number] | undefined = failed, hops = 0;
    run !== undefined && hops < 32;
    hops++
  ) {
    tried.push(run.modelSelection);
    const from: string | null = run.userMessageId.startsWith(ROUTE_MESSAGE_PREFIX)
      ? run.userMessageId.slice(ROUTE_MESSAGE_PREFIX.length)
      : null;
    run = from === null ? undefined : input.runs.find((candidate) => candidate.id === from);
  }
  const option = chooseUsageLimitFallback({
    from: failed.modelSelection,
    routing: input.settings.usageLimitRouting,
    providers: input.providers,
    now: input.nowMs,
    hubOrigins: input.hubOrigins,
    tried,
    fallbackSelection: input.settings.fallbackModelSelection,
    settings: input.settings,
    projectId: input.projectId,
  });
  if (option === null) return null;
  const identity = `${ROUTE_MESSAGE_PREFIX}${failed.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    modelSelection: option.selection,
    text: usageLimitRouteMessage({
      from: failed.modelSelection,
      to: option.selection,
      providers: input.providers,
      resetAt: thread.usageLimitResetAt ?? null,
    }),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const due = DueHint.make();
  const routeCommand = Effect.fn("UsageLimitRecoveryWorker.routeCommand")(function* (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    preferences: ServerSettingsShape,
    nowMs: number,
  ) {
    const resetMs = thread.usageLimitResetAt == null ? NaN : Date.parse(thread.usageLimitResetAt);
    if (
      preferences.usageLimitRouting.onLimit !== "auto-route" ||
      (Number.isFinite(resetMs) && resetMs <= nowMs)
    )
      return null;
    const [shell, records, providers, sources] = yield* Effect.all([
      projections.getThreadShell(thread.id),
      projections.getThreadRecords(thread.id, ["runs"]),
      providerRegistry.getProviders,
      usageLimitSources.current,
    ]);
    return limitRouteCommand({
      thread,
      runs: records.runs,
      settings: preferences,
      providers,
      hubOrigins: sources.flatMap((source) => (source.origin === undefined ? [] : [source.origin])),
      projectId: shell?.projectId ?? null,
      nowMs,
    });
  });
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const autoResume = limitAutoResume(preferences);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume,
      snooze: preferences.snoozeLimitedThreads,
    });
    let acted = false;
    for (const thread of candidates) {
      const routed = yield* routeCommand(thread, preferences, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.route-failed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      const command =
        routed ?? limitRecoveryCommand(thread, autoResume, nowMs, preferences.snoozeLimitedThreads);
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
