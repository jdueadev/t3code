import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { GitManagerServiceError } from "@t3tools/contracts";

/**
 * Why a commit or push cannot start, with the fix, or null when it can.
 * Git would otherwise invent an identity from the host name or fail midway with its own text.
 */
export function stackedActionRefusal(input: {
  readonly wantsCommit: boolean;
  readonly wantsPush: boolean;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly hasRemote: boolean;
}): string | null {
  if (input.wantsCommit && (input.userName === null || input.userEmail === null)) {
    const missing = [
      ...(input.userName === null ? ["user.name"] : []),
      ...(input.userEmail === null ? ["user.email"] : []),
    ].join(" and ");
    return `Git has no ${missing} for this repository, and T3 Code will not commit under an identity you did not choose. Set it with \`git config --global user.name "Your Name"\` and \`git config --global user.email you@example.com\` (drop --global to set it for this repository only), then try again.`;
  }
  if (input.wantsPush && !input.hasRemote) {
    return "This repository has no remote to push the branch to, so a pull request cannot be opened. Add one with `git remote add origin <url>` or publish the repository from the source control menu, then try again. To keep the work without a remote, choose Commit instead.";
  }
  return null;
}

/**
 * Runs before T3 Code pushes a branch for a pull request. The default allows every pull request;
 * a deployment provides its own check, such as one that a fork is level with its upstream.
 */
export class PullRequestPreflight extends Context.Reference<{
  readonly ensureForkFreshBeforePullRequest: (input: {
    readonly cwd: string;
  }) => Effect.Effect<void, GitManagerServiceError>;
}>("t3/git/PullRequestPreflight", {
  defaultValue: () => ({ ensureForkFreshBeforePullRequest: () => Effect.void }),
}) {}
