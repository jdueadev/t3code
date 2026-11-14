import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** One running process, as much of it as the platform lets this server read. */
export interface ProcessSnapshot {
  readonly pid: number;
  readonly name: string;
  readonly exe: string | null;
  readonly cwd: string | null;
}

export interface WorktreeOccupant {
  readonly pid: number;
  readonly name: string;
  readonly via: "working directory" | "executable";
  readonly path: string;
}

/** Runs a helper without a shell; null when it could not run or exited nonzero. */
export type RunHelper = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<string | null>;

function normalize(target: string, windows: boolean): string {
  const unified = windows ? target.replaceAll("/", "\\") : target;
  const trimmed = unified.replace(windows ? /\\+$/ : /\/+$/, "");
  return windows ? trimmed.toLowerCase() : trimmed;
}

/** Processes whose working directory or executable is inside `worktreePath`, never this server. */
export function occupantsInside(
  processes: ReadonlyArray<ProcessSnapshot>,
  worktreePath: string,
  options: { readonly windows: boolean; readonly selfPid: number },
): ReadonlyArray<WorktreeOccupant> {
  const root = normalize(worktreePath, options.windows);
  const separator = options.windows ? "\\" : "/";
  const inside = (target: string | null) => {
    if (target === null || target === "") return false;
    const candidate = normalize(target, options.windows);
    return candidate === root || candidate.startsWith(root + separator);
  };
  return processes.flatMap((process): ReadonlyArray<WorktreeOccupant> => {
    if (process.pid === options.selfPid) return [];
    if (inside(process.cwd))
      return [
        { pid: process.pid, name: process.name, via: "working directory", path: process.cwd! },
      ];
    if (inside(process.exe))
      return [{ pid: process.pid, name: process.name, via: "executable", path: process.exe! }];
    return [];
  });
}

/**
 * The refusal, shaped like a compiler diagnostic: what was refused, which processes and why
 * it matters, then each way forward.
 */
export function worktreeOccupiedDiagnostic(
  worktreePath: string,
  occupants: ReadonlyArray<WorktreeOccupant>,
  windows: boolean,
): string {
  const count = occupants.length === 1 ? "a process runs" : `${occupants.length} processes run`;
  const stop = windows
    ? `Stop-Process -Id ${occupants.map((occupant) => occupant.pid).join(",")}`
    : `kill ${occupants.map((occupant) => occupant.pid).join(" ")}`;
  return [
    `error[worktree-in-use]: refused to remove worktree \`${worktreePath}\` because ${count} from inside it`,
    `  --> ${worktreePath}`,
    "   |",
    ...occupants.map(
      (occupant) =>
        `   = pid ${occupant.pid} \`${occupant.name}\`: ${occupant.via} ${occupant.path}`,
    ),
    "   |",
    "   = why: removing the folder deletes files out from under these processes, and on Windows a folder a process works in cannot be deleted, so the removal would stop half done",
    `   = help: stop the processes (\`${stop}\`), then remove the worktree again`,
    "   = help: if one hosts something you still need, such as a dashboard, start it from a folder outside the worktree first",
    "   = help: to remove it anyway, retry with `ignoreRunningProcesses: true`; the override is logged",
  ].join("\n");
}

// Process.GetProcesses gives pid and name; the image name and the PEB give the executable,
// the working directory, and nothing else. Processes this user cannot open are skipped.
const WINDOWS_SCAN = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class T3WorktreeOccupants {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  static byte[] Read(IntPtr h, long addr, int len) {
    var buf = new byte[len]; IntPtr got;
    if (!ReadProcessMemory(h, new IntPtr(addr), buf, new IntPtr(len), out got) || got.ToInt64() != len) return null;
    return buf;
  }
  public class Row { public int pid; public string name; public string exe; public string cwd; }
  public static List<Row> Scan() {
    var rows = new List<Row>();
    foreach (var p in Process.GetProcesses()) {
      string exe = null, cwd = null;
      IntPtr h = OpenProcess(0x1000, false, p.Id);
      if (h != IntPtr.Zero) {
        var sb = new StringBuilder(32768); int size = sb.Capacity;
        if (QueryFullProcessImageNameW(h, 0, sb, ref size)) exe = sb.ToString(0, size);
        CloseHandle(h);
      }
      h = OpenProcess(0x0410, false, p.Id);
      if (h != IntPtr.Zero) {
        bool wow;
        if (IntPtr.Size == 8 && IsWow64Process(h, out wow) && !wow) {
          var info = new byte[48]; int ret;
          if (NtQueryInformationProcess(h, 0, info, info.Length, out ret) == 0) {
            long peb = BitConverter.ToInt64(info, 8);
            var pebBytes = peb == 0 ? null : Read(h, peb + 0x20, 8);
            long parameters = pebBytes == null ? 0 : BitConverter.ToInt64(pebBytes, 0);
            var block = parameters == 0 ? null : Read(h, parameters, 0x48);
            if (block != null) {
              int length = BitConverter.ToUInt16(block, 0x38);
              long buffer = BitConverter.ToInt64(block, 0x40);
              var text = length == 0 || buffer == 0 ? null : Read(h, buffer, length);
              if (text != null) cwd = Encoding.Unicode.GetString(text);
            }
          }
        }
        CloseHandle(h);
      }
      rows.Add(new Row { pid = p.Id, name = p.ProcessName, exe = exe, cwd = cwd });
    }
    return rows;
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 2 -InputObject @([T3WorktreeOccupants]::Scan())))`;

function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index++) {
    const code = script.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function parseWindowsProcessScan(stdout: string): ReadonlyArray<ProcessSnapshot> | null {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((row): ReadonlyArray<ProcessSnapshot> => {
    if (typeof row !== "object" || row === null) return [];
    const { pid, name, exe, cwd } = row as Record<string, unknown>;
    if (typeof pid !== "number") return [];
    return [
      {
        pid,
        name: typeof name === "string" ? name : String(pid),
        exe: typeof exe === "string" ? exe : null,
        cwd: typeof cwd === "string" ? cwd : null,
      },
    ];
  });
}

/** Parses `lsof -nP -d cwd,txt -Fpcfn`: p<pid>, c<command>, f<fd>, n<name> lines. */
export function parseLsof(stdout: string): ReadonlyArray<ProcessSnapshot> {
  const processes = new Map<number, { name: string; exe: string | null; cwd: string | null }>();
  let pid: number | null = null;
  let fd: string | null = null;
  for (const line of stdout.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        pid = Number(value);
        if (!processes.has(pid)) processes.set(pid, { name: value, exe: null, cwd: null });
        break;
      case "c":
        if (pid !== null) processes.get(pid)!.name = value;
        break;
      case "f":
        fd = value;
        break;
      case "n":
        if (pid === null) break;
        if (fd === "cwd") processes.get(pid)!.cwd = value;
        else if (fd === "txt" && processes.get(pid)!.exe === null) processes.get(pid)!.exe = value;
        break;
    }
  }
  return [...processes].map(([processId, entry]) => ({ pid: processId, ...entry }));
}

/**
 * Lists processes with their working directory and executable: the PEB on Windows, /proc on
 * Linux, lsof elsewhere. Null when the platform gives no answer, which callers treat as unknown.
 */
export const listProcesses = Effect.fn("WorktreeOccupants.listProcesses")(function* (
  platform: NodeJS.Platform,
  run: RunHelper,
) {
  if (platform === "win32") {
    const stdout = yield* run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(WINDOWS_SCAN),
    ]);
    return stdout === null ? null : parseWindowsProcessScan(stdout);
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const pids = yield* fileSystem.readDirectory("/proc").pipe(
    Effect.map((names) => names.filter((name) => /^\d+$/.test(name))),
    Effect.orElseSucceed(() => null),
  );
  if (pids !== null && pids.length > 0) {
    const read = (target: string) =>
      fileSystem.readLink(target).pipe(Effect.orElseSucceed(() => null));
    return yield* Effect.forEach(
      pids,
      (pid) =>
        Effect.all({
          cwd: read(`/proc/${pid}/cwd`),
          exe: read(`/proc/${pid}/exe`),
          name: fileSystem.readFileString(`/proc/${pid}/comm`).pipe(
            Effect.map((text) => text.trim()),
            Effect.orElseSucceed(() => pid),
          ),
        }).pipe(Effect.map((entry): ProcessSnapshot => ({ pid: Number(pid), ...entry }))),
      { concurrency: 32 },
    );
  }
  const stdout = yield* run("lsof", ["-nP", "-w", "-d", "cwd,txt", "-Fpcfn"]);
  return stdout === null ? null : parseLsof(stdout);
});
