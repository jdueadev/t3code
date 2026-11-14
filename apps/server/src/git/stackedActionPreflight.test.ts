import { describe, expect, it } from "vite-plus/test";

import { stackedActionRefusal } from "./stackedActionPreflight.ts";

describe("stackedActionRefusal", () => {
  const ready = {
    wantsCommit: true,
    wantsPush: true,
    userName: "Ada",
    userEmail: "ada@example.com",
    hasRemote: true,
  };

  it("refuses a commit without a configured identity and names the config to set", () => {
    const refusal = stackedActionRefusal({ ...ready, userEmail: null });
    expect(refusal).toContain("no user.email");
    expect(refusal).toContain("git config --global user.email");
    expect(stackedActionRefusal({ ...ready, userName: null, userEmail: null })).toContain(
      "no user.name and user.email",
    );
  });

  it("refuses a push without a remote and points at adding one or committing only", () => {
    const refusal = stackedActionRefusal({ ...ready, hasRemote: false });
    expect(refusal).toContain("git remote add origin");
    expect(refusal).toContain("choose Commit instead");
  });

  it("lets a commit through without a remote, and a push-only action without an identity", () => {
    expect(stackedActionRefusal(ready)).toBeNull();
    expect(stackedActionRefusal({ ...ready, wantsPush: false, hasRemote: false })).toBeNull();
    expect(
      stackedActionRefusal({ ...ready, wantsCommit: false, userName: null, userEmail: null }),
    ).toBeNull();
  });
});
