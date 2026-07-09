import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { LegendListRef } from "@legendapp/list/react";
import { BotIcon, ChevronLeftIcon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { deriveNativeAgentTimelineEntries } from "../session-logic";
import { useProject, useThread } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { cn } from "~/lib/utils";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { NATIVE_AGENT_BLOCKED_INPUT_NOTICE } from "./NativeAgentView.logic";
import type { TurnDiffSummary } from "../types";

const EMPTY_TURN_DIFFS = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();

function statusClasses(status: "running" | "completed" | "failed" | "interrupted"): string {
  switch (status) {
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300";
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "interrupted":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

export function NativeAgentView({
  environmentId,
  threadId,
  agentId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentId: string;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThread(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const agent = thread?.nativeAgents.find((candidate) => candidate.id === agentId) ?? null;
  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  const timelineEntries = useMemo(
    () => deriveNativeAgentTimelineEntries(thread?.activities ?? [], agentId),
    [agentId, thread?.activities],
  );
  const returnToParent = useCallback(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: {},
    });
  }, [navigate, threadRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      returnToParent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [returnToParent]);

  if (!thread || !agent) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="m-auto flex max-w-md flex-col items-center gap-3 px-6 text-center">
          <BotIcon className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium">This sub-agent is no longer available.</p>
          <button
            type="button"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            onClick={returnToParent}
          >
            Return to parent thread
          </button>
        </div>
      </div>
    );
  }

  const isRunning = agent.status === "running";
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="native-agent-view"
    >
      <header className="workspace-topbar flex shrink-0 items-center border-b border-border px-4 pl-[calc(var(--workspace-controls-left)+2.75rem)] sm:px-5 sm:pl-[calc(var(--workspace-controls-left)+3rem)]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BotIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">{agent.title}</h2>
            <button
              type="button"
              onClick={returnToParent}
              className="flex max-w-full cursor-pointer items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronLeftIcon className="size-3 shrink-0" />
              <span className="truncate">sub-agent of {thread.title}</span>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {agent.model ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {agent.model}
              </span>
            ) : null}
            {agent.reasoningEffort ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {agent.reasoningEffort}
              </span>
            ) : null}
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
                statusClasses(agent.status),
              )}
            >
              {agent.status}
            </span>
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          isWorking={isRunning}
          activeTurnInProgress={isRunning}
          activeTurnStartedAt={agent.startedAt}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          runningTurnId={isRunning ? (agent.turnId as TurnId) : null}
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
          routeThreadKey={scopedThreadKey(threadRef)}
          onOpenTurnDiff={() => undefined}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          onRevertUserMessage={() => undefined}
          isRevertingCheckpoint={false}
          onImageExpand={() => undefined}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={thread.worktreePath ?? project?.workspaceRoot}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={project?.workspaceRoot}
          anchorMessageId={null}
          onAnchorReady={() => undefined}
          onAnchorSizeChanged={() => undefined}
          contentInsetEndAdjustment={88}
          onIsAtEndChange={() => undefined}
          onManualNavigation={() => undefined}
        />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-5 sm:pb-4">
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
            <LockIcon className="size-4 shrink-0" />
            <span data-testid="native-agent-blocked-input">
              {NATIVE_AGENT_BLOCKED_INPUT_NOTICE}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
