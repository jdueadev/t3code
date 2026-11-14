import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestLayerParams } from "./pullRequestStack";
import { pullRequestStatus } from "./pullRequestStatus";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { withKnownPullRequestSummary } from "../../state/use-thread-pr";

export function PullRequestStackCard(props: {
  readonly params: PullRequestParams;
  readonly state: PullRequestStackState;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const [unstacking, setUnstacking] = useState(false);
  const target = pullRequestTarget(props.params);
  const editStack = useAtomCommand(composerPullRequests.editStack, { reportFailure: false });
  const mayEditStack = useAtomValue(
    composerPullRequests.editStack.permissionAtom(target.environmentId),
  );
  const stack = props.state.stack;
  if (!stack) {
    const summary =
      props.params.initialSummary?.number === props.params.number
        ? props.params.initialSummary.stack
        : undefined;
    if (!summary) return null;
    return (
      <PullRequestCardGroup>
        <PullRequestCardRow
          title="Stack"
          icon={PullRequestGlyph.stack}
          value={`${summary.position} of ${summary.size}`}
          last
        />
      </PullRequestCardGroup>
    );
  }
  const position = stack.layers.findIndex((layer) => layer.number === props.params.number) + 1;
  const canUnstack =
    mayEditStack &&
    props.state.supportsStackEdits &&
    props.state.isFresh &&
    !unstacking &&
    stack.layers.some((layer) => layer.state === "open");
  const unstack = async () => {
    setUnstacking(true);
    const response = await editStack({
      ...target,
      input: { ...target.input, edit: { kind: "unstack", stackNumber: stack.number } },
    });
    setUnstacking(false);
    props.state.refresh();
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert("Couldn't unstack", cause instanceof Error ? cause.message : "Try again.");
    }
  };
  const confirmUnstack = () =>
    Dialog.alert(
      `Unstack #${stack.number}?`,
      "Its layers stay open as separate pull requests. Merged and queued layers stay stacked.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Unstack", style: "destructive", onPress: () => void unstack() },
      ],
    );
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title="Stack"
        icon={PullRequestGlyph.stack}
        value={`${position} of ${stack.layers.length}`}
        accessibilityLabel={`Stack, ${position} of ${stack.layers.length}${props.state.isFresh ? "" : ", showing saved stack"}`}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === props.params.number;
            const status = pullRequestStatus({
              state: layer.state,
              isDraft: layer.isDraft === true,
            });
            return (
              <View key={layer.number} className={selected ? "bg-thread-selected" : undefined}>
                <PullRequestCardRow
                  title={layer.title ?? layer.headBranch}
                  icon={status.icon}
                  tint={status.tint}
                  value={selected ? "Current" : status.label}
                  detail={`#${layer.number} · ${index + 1} of ${stack.layers.length}`}
                  onPress={
                    selected
                      ? undefined
                      : () =>
                          navigation.dispatch(
                            StackActions.push(
                              "PullRequest",
                              withKnownPullRequestSummary(
                                pullRequestLayerParams(props.params, layer.number),
                              ),
                            ),
                          )
                  }
                  last={!canUnstack && index === stack.layers.length - 1}
                />
              </View>
            );
          })}
          {canUnstack ? (
            <PullRequestCardRow
              title="Unstack"
              icon={PullRequestGlyph.stack}
              destructive
              onPress={confirmUnstack}
              last
            />
          ) : null}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            Base: {stack.base}. Open a layer to review it or merge the stack through that layer.
          </Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  );
}
