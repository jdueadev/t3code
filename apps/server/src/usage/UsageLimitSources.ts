import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(url && /^https?:$/.test(url.protocol) ? { origin: url.origin } : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub answers with a usage limit only when every account it routes the driver to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  for (const source of sources) {
    for (const account of source.accounts) {
      if (account.driver !== driver) continue;
      // An unread account may be the one still blocked, so its refill is unknown.
      if (account.usageLimits.unavailable) return null;
      const spent = account.usageLimits.windows.filter(
        (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
      );
      if (spent.length === 0) return null;
      const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
      if (resets.some((reset) => !Number.isFinite(reset))) return null;
      const recoversAt = Math.max(...resets);
      if (recoversAt <= now) return null;
      earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
    }
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);

/** The failure code of a turn held back because its quota was known to be spent. */
export const USAGE_LIMIT_PREEMPTED_CODE = "usage_limit_preempted";

export interface PreemptiveUsageLimit {
  readonly resetAt: string;
  /** Where the quota was read: the provider, or the usage hub at its endpoint. */
  readonly source: string;
}

/**
 * The limit a turn would hit if it started now: a spent window the provider reports for the
 * model, or a usage hub whose whole pool for the driver is spent. Only a known future reset
 * counts, so stale or partial readings never hold a turn back.
 */
export function preemptiveUsageLimit(input: {
  readonly provider: ServerProvider | undefined;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly model: string;
  readonly now: number;
  /** Exhausted models from the quota router status command, with their earliest reset. */
  readonly routerExhausted?: ReadonlyMap<string, string | null> | null;
}): PreemptiveUsageLimit | null {
  const provider = input.provider;
  if (provider === undefined) return null;
  const future = (resetAt: string | null | undefined) =>
    resetAt != null && Date.parse(resetAt) > input.now ? resetAt : null;
  const window = exhaustedUsageWindow(provider, input.now, input.model);
  const windowReset = future(window?.resetsAt);
  if (windowReset !== null) {
    return { resetAt: windowReset, source: provider.displayName ?? provider.instanceId };
  }
  const endpoint = provider.auth.endpoint;
  if (endpoint === undefined) return null;
  const atEndpoint = input.sources.filter((source) => source.origin === endpoint);
  const hubReset = future(hubPoolResetAt(atEndpoint, provider.driver, input.model, input.now));
  if (hubReset !== null) return { resetAt: hubReset, source: atEndpoint[0]?.label ?? endpoint };
  // The router serves only instances sent to a custom endpoint.
  const routerReset = future(input.routerExhausted?.get(input.model));
  return routerReset === null ? null : { resetAt: routerReset, source: "the quota router" };
}

const QuotaRouterStatus = Schema.Struct({
  schema_version: Schema.Literal(1),
  models: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      state: Schema.String,
      earliest_reset_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeQuotaRouterStatus = Schema.decodeUnknownOption(QuotaRouterStatus);

/**
 * The exhausted models in a quota router status (`quota-tools status --json`), with their
 * earliest reset. Anything unreadable, or another schema version, is no information: null.
 * `near_limit` is left to the router, which moves threads itself.
 */
export function parseQuotaRouterStatus(stdout: string): ReadonlyMap<string, string | null> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const status = decodeQuotaRouterStatus(parsed);
  if (status._tag === "None") return null;
  return new Map(
    status.value.models
      .filter((entry) => entry.state === "exhausted")
      .map((entry) => [entry.model, entry.earliest_reset_at ?? null] as const),
  );
}

const QUOTA_ROUTER_EXHAUSTED_CODE = "quota_router_exhausted";

export interface QuotaRouterExhausted {
  readonly resetAt: string | null;
  readonly message: string | null;
  readonly alternatives: ReadonlyArray<{ readonly model: string; readonly provider: string }>;
}

const QuotaRouterError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal(QUOTA_ROUTER_EXHAUSTED_CODE),
    message: Schema.optional(Schema.String),
    reset_at: Schema.optional(Schema.NullOr(Schema.String)),
    resets_at: Schema.optional(Schema.NullOr(Schema.Number)),
    alternatives: Schema.optional(
      Schema.Array(Schema.Struct({ model: Schema.String, provider: Schema.String })),
    ),
  }),
});
const decodeQuotaRouterError = Schema.decodeUnknownOption(QuotaRouterError);

/**
 * The proxy's final error when no account can serve a model, found in a provider's failure
 * text. It is terminal: retrying cannot succeed before the reset it names.
 */
function parseQuotaRouterExhausted(text: string): QuotaRouterExhausted | null {
  if (!text.includes(QUOTA_ROUTER_EXHAUSTED_CODE)) return null;
  const end = text.lastIndexOf("}");
  for (let start = text.indexOf("{"); start !== -1 && start < end;) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = undefined;
    }
    const decoded = parsed === undefined ? null : decodeQuotaRouterError(parsed);
    if (decoded !== null && decoded._tag === "Some") {
      const error = decoded.value.error;
      const fromUnix =
        error.resets_at == null
          ? null
          : DateTime.formatIso(DateTime.makeUnsafe(error.resets_at * 1000));
      const resetAt =
        error.reset_at != null && Number.isFinite(Date.parse(error.reset_at))
          ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(error.reset_at)))
          : fromUnix;
      return { resetAt, message: error.message ?? null, alternatives: error.alternatives ?? [] };
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

/** Checks a model's quota before its turn starts. The default never holds a turn back. */
export class UsageLimitPreemption extends Context.Reference<{
  readonly check: (selection: ModelSelection) => Effect.Effect<PreemptiveUsageLimit | null>;
}>("t3/usage/UsageLimitPreemption", {
  defaultValue: () => ({ check: () => Effect.succeed(null) }),
}) {}

const QUOTA_STATUS_TTL_MS = 30_000;

export const layerPreemption = Layer.effect(
  UsageLimitPreemption,
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources;
    const settingsService = yield* Settings.ServerSettingsService;
    const processes = yield* ProcessRunner.ProcessRunner;
    const statusCache = yield* Ref.make<{
      readonly key: string;
      readonly at: number;
      readonly value: ReadonlyMap<string, string | null> | null;
    } | null>(null);
    // A failing or slow command is no information, never a held turn.
    const routerExhausted = Effect.gen(function* () {
      const command = (yield* settingsService.getSettings).usageLimitRouting.quotaStatusCommand;
      if (command === null) return null;
      const key = [command.command, ...command.args].join("\u0000");
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const cached = yield* Ref.get(statusCache);
      if (cached !== null && cached.key === key && now - cached.at < QUOTA_STATUS_TTL_MS)
        return cached.value;
      const output = yield* processes.run({
        command: command.command,
        args: command.args,
        timeout: "5 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
      });
      // quota-tools exits 4 when a model is exhausted; the JSON is the answer either way.
      const value = output.timedOut ? null : parseQuotaRouterStatus(output.stdout);
      yield* Ref.set(statusCache, { key, at: now, value });
      return value;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("quota status command failed", { cause }).pipe(Effect.as(null)),
      ),
    );
    return {
      check: Effect.fn("UsageLimitPreemption.check")(function* (selection: ModelSelection) {
        // Cached readings only: a turn start must not wait on a provider or hub request.
        const provider = (yield* providers.getProviders).find(
          (entry) => entry.instanceId === selection.instanceId,
        );
        return preemptiveUsageLimit({
          provider,
          sources: yield* sources.current,
          model: selection.model,
          now: DateTime.toEpochMillis(yield* DateTime.now),
          routerExhausted: provider?.auth.endpoint === undefined ? null : yield* routerExhausted,
        });
      }),
    };
  }),
).pipe(Layer.provide(ProcessRunner.layer));

/**
 * Reads the proxy's final "no account can serve" error out of a provider failure: a terminal
 * usage limit with the reset it names and the router's alternatives, never a retry.
 */
export function classifyQuotaRouterFailure(
  failure: OrchestrationV2ProviderFailure,
): OrchestrationV2ProviderFailure {
  const exhausted = parseQuotaRouterExhausted(failure.message);
  if (exhausted === null) return failure;
  const alternatives =
    exhausted.alternatives.length === 0
      ? ""
      : ` The proxy named these alternatives: ${exhausted.alternatives
          .map((alternative) => `${alternative.model} (${alternative.provider})`)
          .join(", ")}.`;
  const reset = exhausted.resetAt === null ? "" : ` It resets at ${exhausted.resetAt}.`;
  return {
    ...failure,
    class: "usage_limit",
    code: QUOTA_ROUTER_EXHAUSTED_CODE,
    retryable: false,
    message:
      `${exhausted.message ?? "No account behind the proxy can serve this model."}${reset}${alternatives}`.slice(
        0,
        4_096,
      ),
    ...(exhausted.resetAt === null ? {} : { resetAt: exhausted.resetAt }),
  };
}
