import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  occupantsInside,
  parseLsof,
  parseWindowsProcessScan,
  worktreeOccupiedDiagnostic,
  type ProcessSnapshot,
} from "./worktreeOccupants.ts";
import { removeLinkedWorktree } from "./worktreeRemoval.ts";

const processes: ReadonlyArray<ProcessSnapshot> = [
  {
    pid: 10,
    name: "node",
    exe: "C:\\Program Files\\nodejs\\node.exe",
    cwd: "H:\\wt\\repo\\a\\dashboard\\",
  },
  { pid: 11, name: "python", exe: "H:\\WT\\repo\\a\\.venv\\Scripts\\python.exe", cwd: "C:\\" },
  { pid: 12, name: "code", exe: "C:\\code.exe", cwd: "H:\\wt\\repo\\ab" },
  { pid: 13, name: "t3", exe: "C:\\t3.exe", cwd: "H:\\wt\\repo\\a" },
];

describe("worktree occupants", () => {
  it("finds processes working or running from inside a worktree, never a sibling or itself", () => {
    assert.deepStrictEqual(
      occupantsInside(processes, "H:/wt/repo/a", { windows: true, selfPid: 13 }),
      [
        { pid: 10, name: "node", via: "working directory", path: "H:\\wt\\repo\\a\\dashboard\\" },
        {
          pid: 11,
          name: "python",
          via: "executable",
          path: "H:\\WT\\repo\\a\\.venv\\Scripts\\python.exe",
        },
      ],
    );
    assert.deepStrictEqual(
      occupantsInside([{ pid: 1, name: "vite", exe: "/usr/bin/node", cwd: "/wt/A" }], "/wt/a", {
        windows: false,
        selfPid: 0,
      }),
      [],
    );
  });

  it("says what was refused, which process and why, and each way forward", () => {
    const message = worktreeOccupiedDiagnostic(
      "H:\\wt\\repo\\a",
      occupantsInside(processes, "H:\\wt\\repo\\a", { windows: true, selfPid: 13 }),
      true,
    );
    assert.match(
      message,
      /^error\[worktree-in-use\]: refused to remove worktree `H:\\wt\\repo\\a` because 2 processes run from inside it/,
    );
    assert.include(message, "= pid 10 `node`: working directory H:\\wt\\repo\\a\\dashboard\\");
    assert.include(message, "= pid 11 `python`: executable");
    assert.include(message, "= why: ");
    assert.include(message, "`Stop-Process -Id 10,11`");
    assert.include(message, "outside the worktree");
    assert.include(message, "`ignoreRunningProcesses: true`; the override is logged");
  });

  it("reads the Windows scan and lsof output", () => {
    assert.deepStrictEqual(
      parseWindowsProcessScan('[{"pid":4,"name":"System","exe":null,"cwd":null},{"name":"x"}]'),
      [{ pid: 4, name: "System", exe: null, cwd: null }],
    );
    assert.isNull(parseWindowsProcessScan("Add-Type : compile failed"));
    assert.deepStrictEqual(
      parseLsof("p42\ncvite\nfcwd\nn/wt/a\nftxt\nn/usr/bin/node\nftxt\nn/lib/x.so\n"),
      [{ pid: 42, name: "vite", cwd: "/wt/a", exe: "/usr/bin/node" }],
    );
  });

  it.effect("refuses before deleting anything, and removes with the logged override", () =>
    Effect.gen(function* () {
      const ran: Array<ReadonlyArray<string>> = [];
      const remove = (ignoreRunningProcesses: boolean) =>
        removeLinkedWorktree({
          operation: "test",
          cwd: "/repo",
          worktreePath: "/wt/a",
          force: false,
          ignoreRunningProcesses,
          findOccupants: () =>
            Effect.succeed([
              { pid: 7, name: "vite", via: "working directory" as const, path: "/wt/a" },
            ]),
          execute: () => Effect.die("unused"),
          run: (args) => Effect.sync(() => void ran.push(args)),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem),
              Path.layer,
            ),
          ),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      const refused = yield* Effect.exit(remove(false));
      assert.isTrue(Exit.isFailure(refused));
      assert.deepStrictEqual(ran, []);
      const error = Exit.isFailure(refused) ? yield* Effect.flip(remove(false)) : null;
      assert.strictEqual(error?.reason, "worktree_in_use");
      assert.include(error?.detail ?? "", "pid 7 `vite`");
      yield* remove(true);
      assert.strictEqual(ran.length, 1);
    }),
  );
});
