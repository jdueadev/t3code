import { type ModelSelection } from "@t3tools/contracts";
import { UsageLimitFallbackRule } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRule = Schema.decodeUnknownOption(UsageLimitFallbackRule);
const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId && left.model === right.model;

/** One rule per line: `<match> -> <instance>:<model>, <instance>:<model>`. */
export function formatUsageLimitFallbacks(rules: ReadonlyArray<UsageLimitFallbackRule>): string {
  return rules
    .map(
      (rule) =>
        `${rule.match} -> ${rule.fallbacks.map((entry) => `${entry.instanceId}:${entry.model}`).join(", ")}`,
    )
    .join("\n");
}

/** Saved fallbacks keep their model options when a line names them again. */
export function parseUsageLimitFallbacks(
  text: string,
  saved: ReadonlyArray<UsageLimitFallbackRule>,
): { readonly rules: ReadonlyArray<UsageLimitFallbackRule> } | { readonly error: string } {
  const known = saved.flatMap((rule) => rule.fallbacks);
  const rules: Array<UsageLimitFallbackRule> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const [match = "", targets = "", ...rest] = line.split("->");
    const fallbacks = targets.split(",").flatMap((target) => {
      const colon = target.indexOf(":");
      return target.trim() === ""
        ? []
        : [
            {
              instanceId: target.slice(0, Math.max(colon, 0)).trim(),
              model: target.slice(colon + 1).trim(),
            },
          ];
    });
    const rule =
      rest.length > 0 ||
      fallbacks.length === 0 ||
      fallbacks.some((entry) => entry.instanceId === "" || entry.model === "")
        ? undefined
        : Option.getOrUndefined(decodeRule({ match: match.trim(), fallbacks }));
    if (rule === undefined) {
      return {
        error: `Line ${index + 1}: write <instance> or <instance>:<model> -> <instance>:<model>, ...`,
      };
    }
    rules.push({
      match: rule.match,
      fallbacks: rule.fallbacks.map((entry) => known.find((old) => sameModel(old, entry)) ?? entry),
    });
  }
  return { rules };
}
