import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const RUN_STALLED_CODE = "run_stalled";

export class RunStalledError extends Schema.TaggedError<RunStalledError>()("RunStalledError", {
  quietMinutes: Schema.Number,
  afterUsageLimit: Schema.Boolean,
}) {
  override get message(): string {
    const after = this.afterUsageLimit ? " after this run resumed from a usage limit" : "";
    return (
      `Stalled: no output from the provider for ${this.quietMinutes} minutes${after}, ` +
      "with no tool running and nothing waiting on you, so T3 Code stopped the run. " +
      "Send a message to try again or switch the model. " +
      "Settings > Usage limits > Stall after sets how long to wait."
    );
  }
}

const isRunStalledError = Schema.is(RunStalledError);

/** Finds a stall anywhere in an error's `cause` chain, since ingestion wraps stream failures. */
export function runStalledErrorOf(error: unknown): RunStalledError | null {
  for (let current = error, depth = 0; current != null && depth < 8; depth++) {
    if (isRunStalledError(current)) return current;
    current = typeof current === "object" && "cause" in current ? current.cause : null;
  }
  return null;
}

/**
 * Fails with `RunStalledError` once `stream` has emitted nothing for `stallMs`, unless
 * `quietAllowed` says the silence is expected (a tool runs, a request waits on the user). An
 * allowed silence restarts the window. `stallMs: null` turns the watchdog off.
 */
export function failWhenStalled<A, E, R>(
  stream: Stream.Stream<A, E, R>,
  options: {
    readonly stallMs: number | null;
    readonly quietAllowed: Effect.Effect<boolean>;
    readonly afterUsageLimit: boolean;
  },
): Stream.Stream<A, E | RunStalledError, R> {
  const stallMs = options.stallMs;
  if (stallMs === null) return stream;
  return Stream.unwrap(
    Effect.gen(function* () {
      const lastActivity = yield* Ref.make(yield* Clock.currentTimeMillis);
      const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(lastActivity, now));
      const watch = Effect.gen(function* () {
        while (true) {
          const quietFor = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastActivity));
          if (quietFor < stallMs) {
            yield* Effect.sleep(Duration.millis(stallMs - quietFor));
            continue;
          }
          if (!(yield* options.quietAllowed)) {
            return yield* new RunStalledError({
              quietMinutes: Math.round(quietFor / 60_000),
              afterUsageLimit: options.afterUsageLimit,
            });
          }
          yield* touch;
        }
      });
      return stream.pipe(
        Stream.tap(() => touch),
        Stream.merge(Stream.fromEffectDrain(watch), { haltStrategy: "left" }),
      );
    }),
  );
}
