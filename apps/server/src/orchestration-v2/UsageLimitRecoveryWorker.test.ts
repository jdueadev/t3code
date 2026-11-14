import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  limitAutoResume,
  limitRecoveryCommand,
  limitRouteCommand,
} from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
              usageLimitRouting: DEFAULT_SERVER_SETTINGS.usageLimitRouting,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("usage limit setting", () => {
  const instance = ProviderInstanceId.make;
  const codex = { instanceId: instance("codex"), model: "gpt-6.1-sol" };
  const claude = { instanceId: instance("claudeAgent"), model: "claude-fable-5-1" };
  const local = { instanceId: instance("llama"), model: "qwen-coder" };
  const provider = (
    instanceId: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: instance(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const providers = [
    provider("codex"),
    provider("claudeAgent"),
    provider("llama", { auth: { status: "authenticated", endpoint: "http://127.0.0.1:8080" } }),
  ];
  const settings = (
    routing: Partial<ServerSettingsShape["usageLimitRouting"]>,
  ): ServerSettingsShape => ({
    ...DEFAULT_SERVER_SETTINGS,
    usageLimitRouting: {
      ...DEFAULT_SERVER_SETTINGS.usageLimitRouting,
      fallbacks: [
        { match: "codex", fallbacks: [claude] },
        { match: "claudeAgent", fallbacks: [codex] },
        { match: "llama", fallbacks: [claude] },
      ],
      ...routing,
    },
  });
  // Limited one hour ago, resets in one hour.
  const limited = failedThread(HOUR_MS, -HOUR_MS);
  const run = (id: string, modelSelection: typeof codex, userMessageId = `message:${id}`) => ({
    id: RunId.make(id),
    modelSelection,
    userMessageId: MessageId.make(userMessageId),
  });
  const route = (
    routing: Partial<ServerSettingsShape["usageLimitRouting"]>,
    runs = [run("run:limited", codex)],
    thread = limited,
  ) =>
    limitRouteCommand({
      thread,
      runs,
      settings: settings(routing),
      providers,
      hubOrigins: [],
      projectId: null,
      nowMs,
    });

  it.each([
    ["ask", false, false],
    ["ask", true, true],
    ["wait", false, true],
    ["auto-route", false, true],
  ] as const)("%s with auto-resume %s resumes at the reset: %s", (onLimit, toggle, expected) => {
    assert.equal(
      limitAutoResume({ ...settings({ onLimit }), autoResumeLimitedThreads: toggle }),
      expected,
    );
  });

  it("ask and wait never switch the model", () => {
    assert.isNull(route({ onLimit: "ask" }));
    assert.isNull(route({ onLimit: "wait" }));
  });

  it("auto-route continues on the fallback and says why in the thread", () => {
    const command = route({ onLimit: "auto-route" });
    assert.deepEqual(command?.modelSelection, claude);
    assert.equal(command?.createdBy, "agent");
    assert.equal(command?.messageId, "limit-route:run:limited");
    assert.match(command?.text ?? "", /moved this thread from codex gpt-6\.1-sol to claudeAgent/);
    assert.match(command?.text ?? "", /reached its usage limit/);
  });

  it("auto-route ends a chain instead of bouncing back to a spent model", () => {
    const runs = [run("run:first", codex), run("run:limited", claude, "limit-route:run:first")];
    assert.isNull(route({ onLimit: "auto-route" }, runs));
  });

  it("auto-route waits once the original model's reset has passed", () => {
    assert.isNull(route({ onLimit: "auto-route" }, undefined, failedThread(2 * HOUR_MS, HOUR_MS)));
  });

  it("auto-route keeps a local model local unless the remote provider is allowed", () => {
    const runs = [run("run:limited", local)];
    assert.isNull(route({ onLimit: "auto-route" }, runs));
    assert.deepEqual(
      route({ onLimit: "auto-route", remoteFallbackInstances: [claude.instanceId] }, runs)
        ?.modelSelection,
      claude,
    );
  });
});
