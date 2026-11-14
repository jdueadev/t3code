import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);

const claudeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", endpoint: "http://hub.test" },
  checkedAt: at(0),
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.each([
  {
    name: "the provider's own spent window",
    provider: claudeProvider({
      usageLimits: { checkedAt: at(0), windows: [spent("five_hour", 3)] },
    }),
    sources: [],
    expected: { resetAt: at(3), source: "claude" },
  },
  {
    name: "a hub whose whole pool for the driver is spent",
    provider: claudeProvider(),
    sources: [{ ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" }],
    expected: { resetAt: at(2), source: "hub" },
  },
  {
    name: "nothing while the hub still has an account with room",
    provider: claudeProvider(),
    sources: [
      {
        ...hub([{ windows: [spent("five_hour", 2)] }, { windows: [] }]),
        origin: "http://hub.test",
      },
    ],
    expected: null,
  },
  {
    name: "nothing from a hub at another endpoint",
    provider: claudeProvider(),
    sources: [{ ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://other.test" }],
    expected: null,
  },
  {
    name: "nothing when the spent window's reset is unknown",
    provider: claudeProvider({
      usageLimits: {
        checkedAt: at(0),
        windows: [{ ...spent("five_hour", 3), resetsAt: undefined }],
      },
    }),
    sources: [],
    expected: null,
  },
  { name: "nothing for an unknown instance", provider: undefined, sources: [], expected: null },
])("pre-empts a turn on $name", ({ provider, sources, expected }) => {
  expect(
    UsageLimitSources.preemptiveUsageLimit({
      provider,
      sources,
      model: "claude-haiku-5-5",
      now: NOW,
    }),
  ).toEqual(expected);
});

const quotaStatusFixture = {
  schema_version: 1,
  generated_at: "2026-11-13T12:00:00Z",
  routing: "fill-first",
  final_error: true,
  thresholds: { preempt_at: 90, block_at: 100 },
  models: [
    {
      model: "claude-haiku-5-5",
      providers: ["claude"],
      state: "exhausted",
      earliest_reset_at: at(2),
      would_pick: null,
      accounts: { ok: 0, near_limit: 0, cooldown: 2, total: 2 },
    },
    {
      model: "gpt-6.1-sol",
      providers: ["codex"],
      state: "near_limit",
      earliest_reset_at: null,
      would_pick: "acct-1",
      accounts: { ok: 0, near_limit: 1, cooldown: 0, total: 1 },
    },
    { model: "qwen", providers: ["local"], state: "ok", earliest_reset_at: null },
  ],
  accounts: [{ label: "acct-1" }],
};

it("reads exhausted models from a quota router status, and nothing else", () => {
  const exhausted = UsageLimitSources.parseQuotaRouterStatus(JSON.stringify(quotaStatusFixture));
  expect([...(exhausted ?? new Map())]).toEqual([["claude-haiku-5-5", at(2)]]);
  expect(
    UsageLimitSources.parseQuotaRouterStatus(
      JSON.stringify({ ...quotaStatusFixture, schema_version: 2 }),
    ),
  ).toBeNull();
  expect(UsageLimitSources.parseQuotaRouterStatus("quota-tools: data dir missing")).toBeNull();
  // A near limit model is the router's to move, so it holds no turn back.
  expect(
    UsageLimitSources.preemptiveUsageLimit({
      provider: claudeProvider({
        auth: { status: "authenticated", endpoint: "http://proxy.test" },
      }),
      sources: [],
      model: "claude-haiku-5-5",
      now: NOW,
      routerExhausted: exhausted,
    }),
  ).toEqual({ resetAt: at(2), source: "the quota router" });
  expect(
    UsageLimitSources.preemptiveUsageLimit({
      provider: claudeProvider(),
      sources: [],
      model: "gpt-6.1-sol",
      now: NOW,
      routerExhausted: exhausted,
    }),
  ).toBeNull();
});

const finalErrorFixture = {
  type: "error",
  error: {
    type: "usage_limit_reached",
    code: "quota_router_exhausted",
    retryable: false,
    model: "claude-haiku-5-5",
    providers: ["claude"],
    resets_at: Math.floor(Date.parse(at(3)) / 1000),
    reset_at: "2026-11-13T15:00:00Z",
    resets_in_seconds: 10_800,
    reset_estimated: false,
    retry_after_seconds: 10_800,
    accounts: { total: 2, in_cooldown: 0, at_limit: 2 },
    alternatives: [{ model: "gpt-6.1-sol", provider: "codex" }],
    message: "Every account for claude-haiku-5-5 is at its limit.",
    schema_version: 1,
  },
};

it("turns the proxy's final error into a terminal usage limit with its reset", () => {
  const failure = UsageLimitSources.classifyQuotaRouterFailure({
    class: "provider_error",
    message: `unexpected status 429 Too Many Requests: ${JSON.stringify(finalErrorFixture)} (request id abc)`,
    code: null,
    retryable: true,
  });
  expect(failure).toMatchObject({
    class: "usage_limit",
    code: "quota_router_exhausted",
    retryable: false,
    resetAt: "2026-11-13T15:00:00.000Z",
  });
  expect(failure.message).toContain("gpt-6.1-sol (codex)");
  const other = {
    class: "provider_error" as const,
    message: "429 rate limited",
    code: null,
    retryable: true,
  };
  expect(UsageLimitSources.classifyQuotaRouterFailure(other)).toBe(other);
});
