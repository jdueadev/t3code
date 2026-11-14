import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { RunStalledError, failWhenStalled, runStalledErrorOf } from "./RunStallWatchdog.ts";

const TEN_MINUTES = 10 * 60_000;

describe("failWhenStalled", () => {
  it.effect("fails a silent run once the stall window passes", () =>
    Effect.gen(function* () {
      const fiber = yield* failWhenStalled(Stream.never, {
        stallMs: TEN_MINUTES,
        quietAllowed: Effect.succeed(false),
        afterUsageLimit: true,
      }).pipe(Stream.runDrain, Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, RunStalledError);
      assert.strictEqual(error.quietMinutes, 10);
      assert.match(error.message, /after this run resumed from a usage limit/);
    }),
  );

  it.effect("does not fire while events keep arriving", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<number, Cause.Done>();
      const fiber = yield* failWhenStalled(Stream.fromQueue(events), {
        stallMs: TEN_MINUTES,
        quietAllowed: Effect.succeed(false),
        afterUsageLimit: false,
      }).pipe(Stream.runCollect, Effect.forkChild);
      for (const value of [1, 2, 3]) {
        yield* TestClock.adjust("9 minutes");
        yield* Queue.offer(events, value);
      }
      yield* Queue.end(events);
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [1, 2, 3]);
    }),
  );

  it.effect("does not fire while a tool runs or a request waits, then fires after it", () =>
    Effect.gen(function* () {
      const allowed = yield* Ref.make(true);
      const fiber = yield* failWhenStalled(Stream.never, {
        stallMs: TEN_MINUTES,
        quietAllowed: Ref.get(allowed),
        afterUsageLimit: false,
      }).pipe(Stream.runDrain, Effect.forkChild);
      yield* TestClock.adjust("45 minutes");
      assert.isUndefined(fiber.pollUnsafe());
      yield* Ref.set(allowed, false);
      yield* TestClock.adjust("10 minutes");
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("is off when no stall time is set", () =>
    Effect.gen(function* () {
      const fiber = yield* failWhenStalled(Stream.never, {
        stallMs: null,
        quietAllowed: Effect.succeed(false),
        afterUsageLimit: false,
      }).pipe(Stream.runDrain, Effect.forkChild);
      yield* TestClock.adjust("1 day");
      assert.isUndefined(fiber.pollUnsafe());
      yield* Fiber.interrupt(fiber);
    }),
  );

  it("finds a stall wrapped by ingestion errors", () => {
    const stall = new RunStalledError({ quietMinutes: 10, afterUsageLimit: false });
    assert.strictEqual(runStalledErrorOf({ cause: { cause: stall } }), stall);
    assert.isNull(runStalledErrorOf(new Error("other")));
  });
});
