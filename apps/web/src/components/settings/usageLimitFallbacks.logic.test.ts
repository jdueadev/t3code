import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatUsageLimitFallbacks, parseUsageLimitFallbacks } from "./usageLimitFallbacks.logic";

const codex = ProviderInstanceId.make("codex");
const local = ProviderInstanceId.make("ollama");

describe("usage limit fallback list", () => {
  it("round-trips rules and keeps the options of fallbacks it names again", () => {
    const saved = [
      {
        match: "claudeAgent:claude-opus*",
        fallbacks: [
          {
            instanceId: codex,
            model: "gpt-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          { instanceId: local, model: "qwen3:32b" },
        ],
      },
    ];
    const text = formatUsageLimitFallbacks(saved);
    expect(text).toBe("claudeAgent:claude-opus* -> codex:gpt-5, ollama:qwen3:32b");
    expect(parseUsageLimitFallbacks(`${text}\n\n  codex ->ollama:qwen3:32b  `, saved)).toEqual({
      rules: [...saved, { match: "codex", fallbacks: [saved[0]!.fallbacks[1]] }],
    });
  });

  it.each(["codex", "codex -> gpt-5", "codex -> ", "a -> b:c -> d:e", " -> codex:gpt-5"])(
    "refuses %j and names the line",
    (line) => {
      expect(parseUsageLimitFallbacks(`codex -> ollama:qwen3\n${line}`, [])).toEqual({
        error: expect.stringMatching(/^Line 2: /),
      });
    },
  );
});
