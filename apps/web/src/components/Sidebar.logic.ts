import * as React from "react";
import type { ThreadId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 6,
  Failed: 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

// A failed thread is one whose latest turn settled to `error` and that the user
// has not opened since (same recency contract as `hasUnseenCompletion`). Once the
// user visits the thread the failure stops surfacing as a pill.
export function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestTurn?.state !== "error") return false;
  if (!thread.latestTurn.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
    startFromOrigin: boolean;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
  startFromOrigin?: boolean;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
      startFromOrigin: input.activeDraftThread.startFromOrigin,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-6 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:h-7";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-destructive",
      dotClass: "bg-destructive",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export interface SidebarThreadTreeNode<TThread> {
  thread: TThread;
  /** Structural depth (root = 0). Rendering caps the *indent* at 3; this value is uncapped. */
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  /**
   * Highest-priority status across this node's whole subtree (itself + descendants).
   * A collapsed parent renders this rollup instead of its own pill. `null` when
   * `resolveStatus` is omitted or nothing in the subtree has a status.
   */
  subtreeStatus: ThreadStatusPill | null;
}

/**
 * Flattens sorted threads into the single visible row order consumed by rendering
 * AND every flat-order consumer (orderedProjectThreadKeys, visibleSidebarThreadKeys,
 * rangeSelectTo, resolveAdjacentThreadId, Cmd+1..9 jumps).
 *
 * Tree structure is derived ONLY from `parentThreadId` (server-authoritative). A
 * thread whose parent is not present in `threads` (deleted / archived / filtered
 * out) is an orphan and renders at root level rather than disappearing.
 *
 * `threads` must already be `sortThreads()`-ordered. That ordering is a total order
 * by sort timestamp, so a thread's input index is a faithful proxy for its
 * timestamp: siblings keep their `sortThreads` order, and a parent's effective sort
 * key is the minimum input index across its subtree (= the subtree's max timestamp).
 * An active child therefore bubbles its whole ancestor chain up the list.
 *
 * `resolveStatus` is the only addition to the documented contract: `subtreeStatus`
 * is a rollup of per-thread status pills, which cannot be derived from
 * `{ id, parentThreadId }` alone. Callers that only care about order omit it.
 */
export function buildSidebarThreadTree<
  TThread extends { id: ThreadId; parentThreadId: ThreadId | null },
>(input: {
  threads: readonly TThread[];
  expandedThreadIds: ReadonlySet<ThreadId>;
  pinnedThreadId: ThreadId | null;
  resolveStatus?: (thread: TThread) => ThreadStatusPill | null;
}): Array<SidebarThreadTreeNode<TThread>> {
  const { expandedThreadIds, pinnedThreadId, threads } = input;
  const resolveStatus = input.resolveStatus ?? (() => null);

  const byId = new Map<ThreadId, TThread>();
  const inputIndex = new Map<ThreadId, number>();
  threads.forEach((thread, index) => {
    byId.set(thread.id, thread);
    inputIndex.set(thread.id, index);
  });

  // Orphans (parent missing) are grouped under the root bucket (key `null`).
  const effectiveParentId = (thread: TThread): ThreadId | null =>
    thread.parentThreadId !== null && byId.has(thread.parentThreadId)
      ? thread.parentThreadId
      : null;

  const childrenByParent = new Map<ThreadId | null, TThread[]>();
  for (const thread of threads) {
    const key = effectiveParentId(thread);
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(thread);
    else childrenByParent.set(key, [thread]);
  }

  const childrenOf = (id: ThreadId | null): readonly TThread[] => childrenByParent.get(id) ?? [];

  // Subtree-min input index = subtree-max sort timestamp (see doc comment).
  const subtreeMinIndex = new Map<ThreadId, number>();
  const computeMinIndex = (thread: TThread): number => {
    let min = inputIndex.get(thread.id) ?? Number.POSITIVE_INFINITY;
    for (const child of childrenOf(thread.id)) {
      min = Math.min(min, computeMinIndex(child));
    }
    subtreeMinIndex.set(thread.id, min);
    return min;
  };
  for (const root of childrenOf(null)) computeMinIndex(root);

  const sortSiblings = (siblings: readonly TThread[]): TThread[] =>
    [...siblings].sort(
      (left, right) => (subtreeMinIndex.get(left.id) ?? 0) - (subtreeMinIndex.get(right.id) ?? 0),
    );

  // Subtree status rollup (self + descendants), highest priority wins.
  const subtreeStatus = new Map<ThreadId, ThreadStatusPill | null>();
  const computeStatus = (thread: TThread): ThreadStatusPill | null => {
    const statuses: Array<ThreadStatusPill | null> = [resolveStatus(thread)];
    for (const child of childrenOf(thread.id)) statuses.push(computeStatus(child));
    const rolled = resolveProjectStatusIndicator(statuses);
    subtreeStatus.set(thread.id, rolled);
    return rolled;
  };
  for (const root of childrenOf(null)) computeStatus(root);

  const depthById = new Map<ThreadId, number>();
  const depthOf = (id: ThreadId): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    const thread = byId.get(id);
    const parentId = thread ? effectiveParentId(thread) : null;
    const depth = parentId === null ? 0 : depthOf(parentId) + 1;
    depthById.set(id, depth);
    return depth;
  };

  const isDescendantOf = (ancestorId: ThreadId, candidateId: ThreadId): boolean => {
    let cursor = byId.get(candidateId);
    while (cursor) {
      const parentId = effectiveParentId(cursor);
      if (parentId === null) return false;
      if (parentId === ancestorId) return true;
      cursor = byId.get(parentId);
    }
    return false;
  };

  const output: Array<SidebarThreadTreeNode<TThread>> = [];
  const emitted = new Set<ThreadId>();

  const toNode = (
    thread: TThread,
    depth: number,
    hasChildren: boolean,
    isExpanded: boolean,
  ): SidebarThreadTreeNode<TThread> => ({
    thread,
    depth,
    hasChildren,
    isExpanded,
    subtreeStatus: subtreeStatus.get(thread.id) ?? null,
  });

  const walk = (thread: TThread, depth: number): void => {
    const children = sortSiblings(childrenOf(thread.id));
    const hasChildren = children.length > 0;
    const isExpanded = hasChildren && expandedThreadIds.has(thread.id);
    output.push(toNode(thread, depth, hasChildren, isExpanded));
    emitted.add(thread.id);

    if (isExpanded) {
      for (const child of children) walk(child, depth + 1);
      return;
    }
    // Collapsed: keep the pinned (active) thread visible even under a collapsed
    // ancestor, surfaced once as a lone row at its true depth.
    if (
      hasChildren &&
      pinnedThreadId !== null &&
      !emitted.has(pinnedThreadId) &&
      isDescendantOf(thread.id, pinnedThreadId)
    ) {
      const pinned = byId.get(pinnedThreadId);
      if (pinned) {
        const pinnedHasChildren = childrenOf(pinnedThreadId).length > 0;
        output.push(toNode(pinned, depthOf(pinnedThreadId), pinnedHasChildren, false));
        emitted.add(pinnedThreadId);
      }
    }
  };

  for (const root of sortSiblings(childrenOf(null))) walk(root, 0);
  return output;
}

/**
 * Roots-only preview slicing over a flattened tree. Counts root nodes only; an
 * expanded root shows all its descendants regardless of the budget. The block
 * containing the active thread is always kept even when it falls past the budget.
 */
export function sliceSidebarThreadTreeToPreview<TThread extends { id: ThreadId }>(input: {
  nodes: ReadonlyArray<SidebarThreadTreeNode<TThread>>;
  previewLimit: number;
  activeThreadId: ThreadId | null;
  isExpanded: boolean;
}): {
  rendered: Array<SidebarThreadTreeNode<TThread>>;
  hidden: Array<SidebarThreadTreeNode<TThread>>;
  hasHiddenRoots: boolean;
} {
  const { activeThreadId, isExpanded, nodes, previewLimit } = input;

  // Group into root-blocks: a depth-0 node plus every following node until the
  // next depth-0 node (its rendered descendants + any surfaced pinned row).
  const blocks: Array<Array<SidebarThreadTreeNode<TThread>>> = [];
  for (const node of nodes) {
    if (node.depth === 0 || blocks.length === 0) {
      blocks.push([node]);
    } else {
      blocks[blocks.length - 1]!.push(node);
    }
  }

  const rootCount = blocks.length;
  const hasHiddenRoots = rootCount > previewLimit;
  if (isExpanded || !hasHiddenRoots) {
    return { rendered: [...nodes], hidden: [], hasHiddenRoots };
  }

  const rendered: Array<SidebarThreadTreeNode<TThread>> = [];
  const hidden: Array<SidebarThreadTreeNode<TThread>> = [];
  blocks.forEach((block, index) => {
    const withinBudget = index < previewLimit;
    const containsActive =
      activeThreadId !== null && block.some((node) => node.thread.id === activeThreadId);
    if (withinBudget || containsActive) {
      rendered.push(...block);
    } else {
      hidden.push(...block);
    }
  });

  return { rendered, hidden, hasHiddenRoots };
}

/**
 * The single source of truth for a project's rendered thread rows: flattens the
 * sub-thread tree, then applies roots-only preview slicing. Both the render path
 * (`orderedProjectThreadKeys` / rows) and the global flat-order path
 * (`visibleSidebarThreadKeys`) call this so their orders can never diverge.
 *
 * `sortedThreads` must be `sortThreads()`-ordered and already filtered to the
 * project's non-archived threads. Thread disclosure defaults to expanded; only
 * threads explicitly collapsed in `threadExpandedById` hide their descendants.
 */
export function buildRenderedProjectThreadTree<
  TThread extends { id: ThreadId; parentThreadId: ThreadId | null },
>(input: {
  sortedThreads: readonly TThread[];
  threadExpandedById: Readonly<Record<string, boolean>>;
  activeThreadId: ThreadId | null;
  previewLimit: number;
  isThreadListExpanded: boolean;
  resolveStatus?: (thread: TThread) => ThreadStatusPill | null;
}): {
  rendered: Array<SidebarThreadTreeNode<TThread>>;
  hidden: Array<SidebarThreadTreeNode<TThread>>;
  hasHiddenRoots: boolean;
} {
  const {
    activeThreadId,
    isThreadListExpanded,
    previewLimit,
    resolveStatus,
    sortedThreads,
    threadExpandedById,
  } = input;

  const expandedThreadIds = new Set<ThreadId>();
  for (const thread of sortedThreads) {
    if (threadExpandedById[thread.id] ?? true) {
      expandedThreadIds.add(thread.id);
    }
  }

  const nodes = buildSidebarThreadTree({
    threads: sortedThreads,
    expandedThreadIds,
    pinnedThreadId: activeThreadId,
    ...(resolveStatus ? { resolveStatus } : {}),
  });

  return sliceSidebarThreadTreeToPreview({
    nodes,
    previewLimit,
    activeThreadId,
    isExpanded: isThreadListExpanded,
  });
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
