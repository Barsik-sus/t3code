import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildSidebarThreadTree,
  createThreadJumpHintVisibilityController,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  hasUnseenFailure,
  sliceSidebarThreadTreeToPreview,
  type SidebarThreadTreeNode,
  type ThreadStatusPill,
  isContextMenuPointerDown,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveNativeAgentStatusPill,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarStageBadgeLabel,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { useThreadSelectionStore } from "../threadSelectionStore";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });
});

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: undefined,
        session: null,
      }),
    ).toBe(false);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadSeedContext", () => {
  it("prefers the default worktree mode over active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "feature/existing",
          worktreePath: "/repo/.t3/worktrees/existing",
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/draft",
          worktreePath: "/repo/.t3/worktrees/draft",
          envMode: "worktree",
          startFromOrigin: true,
        },
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });

  it("inherits the active server thread context when creating a new thread in the same project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft thread context when it matches the target project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
          startFromOrigin: true,
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("falls back to the default env mode when there is no matching active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.make("thread-12"),
            ThreadId.make("thread-11"),
            ThreadId.make("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.make("thread-8"), ThreadId.make("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.make("thread-12"),
      ThreadId.make("thread-11"),
      ThreadId.make("thread-10"),
      ThreadId.make("thread-8"),
      ThreadId.make("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [ThreadId.make("thread-hidden-2"), ThreadId.make("thread-hidden-1")],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.make("thread-12"), ThreadId.make("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.make("thread-12"), ThreadId.make("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveNativeAgentStatusPill", () => {
  it.each([
    ["running", "Working", true],
    ["completed", "Completed", false],
    ["failed", "Failed", false],
    ["interrupted", "Interrupted", false],
  ] as const)("maps %s to %s", (status, label, pulse) => {
    expect(resolveNativeAgentStatusPill(status)).toMatchObject({ label, pulse });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
      ThreadId.make("thread-4"),
      ThreadId.make("thread-5"),
      ThreadId.make("thread-6"),
      ThreadId.make("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-7")]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    origin: { kind: "user" as const },
    rootThreadId: ThreadId.make("thread-1"),
    depth: 0,
    checkpoints: [],
    activities: [],
    nativeAgents: [],
    ...overrides,
  };
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            turnId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            turnId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

interface TreeThread {
  id: ThreadId;
  parentThreadId: ThreadId | null;
}

function treeThread(id: string, parentId: string | null): TreeThread {
  return {
    id: ThreadId.make(id),
    parentThreadId: parentId === null ? null : ThreadId.make(parentId),
  };
}

function expandedSet(...ids: string[]): ReadonlySet<ThreadId> {
  return new Set(ids.map((id) => ThreadId.make(id)));
}

function orderedIds(nodes: ReadonlyArray<SidebarThreadTreeNode<TreeThread>>): string[] {
  return nodes.map((node) => node.thread.id);
}

const WORKING_PILL: ThreadStatusPill = {
  label: "Working",
  colorClass: "",
  dotClass: "",
  pulse: true,
};
const COMPLETED_PILL: ThreadStatusPill = {
  label: "Completed",
  colorClass: "",
  dotClass: "",
  pulse: false,
};
const FAILED_PILL: ThreadStatusPill = {
  label: "Failed",
  colorClass: "",
  dotClass: "",
  pulse: false,
};

describe("buildSidebarThreadTree", () => {
  it("appends native-agent leaves after real children and rolls running status into a collapsed parent", () => {
    const parent = {
      ...treeThread("parent-p", null),
      nativeAgents: [
        {
          id: "agent-1",
          title: "Review persistence",
          status: "running" as const,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const child = { ...treeThread("child-c", "parent-p"), nativeAgents: [] };
    const expanded = buildSidebarThreadTree({
      threads: [parent, child],
      expandedThreadIds: expandedSet("parent-p"),
      pinnedThreadId: null,
    });

    expect(expanded.map((node) => node.kind)).toEqual(["thread", "thread", "native-agent"]);
    expect(expanded[2]).toMatchObject({
      kind: "native-agent",
      depth: 1,
      agent: { id: "agent-1", title: "Review persistence" },
      hasChildren: false,
      subtreeStatus: { label: "Working", pulse: true },
    });

    const collapsed = buildSidebarThreadTree({
      threads: [parent, child],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      kind: "thread",
      hasChildren: true,
      isExpanded: false,
      subtreeStatus: { label: "Working", pulse: true },
    });
  });

  it("keeps settled native agents from the latest turn visible", () => {
    const parent = {
      ...treeThread("parent-settled", null),
      nativeAgents: [
        {
          id: "agent-settled",
          title: "Finished review",
          status: "completed" as const,
          turnId: TurnId.make("turn-latest"),
          model: "gpt-5.4",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
    };
    const nodes = buildSidebarThreadTree({
      threads: [parent],
      expandedThreadIds: expandedSet("parent-settled"),
      pinnedThreadId: null,
    });

    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({
      kind: "native-agent",
      agent: { id: "agent-settled", status: "completed", turnId: "turn-latest" },
      subtreeStatus: { label: "Completed" },
    });
  });

  it("flattens a child directly below its expanded parent with incremented depth", () => {
    const nodes = buildSidebarThreadTree({
      threads: [
        treeThread("root-a", null),
        treeThread("a-child", "root-a"),
        treeThread("root-b", null),
      ],
      expandedThreadIds: expandedSet("root-a"),
      pinnedThreadId: null,
    });

    expect(orderedIds(nodes)).toEqual(["root-a", "a-child", "root-b"]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 0]);
    expect(nodes[0]).toMatchObject({ hasChildren: true, isExpanded: true });
    expect(nodes[1]).toMatchObject({ hasChildren: false, isExpanded: false });
  });

  it("hides descendants of a collapsed parent while keeping the disclosure state", () => {
    const nodes = buildSidebarThreadTree({
      threads: [
        treeThread("root-a", null),
        treeThread("a-child", "root-a"),
        treeThread("root-b", null),
      ],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
    });

    expect(orderedIds(nodes)).toEqual(["root-a", "root-b"]);
    expect(nodes[0]).toMatchObject({ hasChildren: true, isExpanded: false });
  });

  it("renders orphans (parent absent) at root level rather than dropping them", () => {
    const nodes = buildSidebarThreadTree({
      threads: [treeThread("orphan", "deleted-parent"), treeThread("root-b", null)],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
    });

    expect(orderedIds(nodes)).toEqual(["orphan", "root-b"]);
    expect(nodes[0]!.depth).toBe(0);
  });

  it("returns uncapped structural depth for deep chains", () => {
    const nodes = buildSidebarThreadTree({
      threads: [
        treeThread("a", null),
        treeThread("b", "a"),
        treeThread("c", "b"),
        treeThread("d", "c"),
      ],
      expandedThreadIds: expandedSet("a", "b", "c"),
      pinnedThreadId: null,
    });

    expect(orderedIds(nodes)).toEqual(["a", "b", "c", "d"]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 2, 3]);
  });

  it("bubbles a parent above other roots by its subtree's max sort position", () => {
    // Input is sortThreads-ordered: the active child is newest (index 0), its
    // parent is oldest (last). The parent must still bubble above `root-other`.
    const threads = [
      treeThread("child-c", "parent-p"),
      treeThread("root-other", null),
      treeThread("parent-p", null),
    ];

    const expanded = buildSidebarThreadTree({
      threads,
      expandedThreadIds: expandedSet("parent-p"),
      pinnedThreadId: null,
    });
    expect(orderedIds(expanded)).toEqual(["parent-p", "child-c", "root-other"]);

    const collapsed = buildSidebarThreadTree({
      threads,
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
    });
    expect(orderedIds(collapsed)).toEqual(["parent-p", "root-other"]);
  });

  it("keeps a pinned active descendant visible under a collapsed ancestor", () => {
    const nodes = buildSidebarThreadTree({
      threads: [
        treeThread("parent-p", null),
        treeThread("child-c", "parent-p"),
        treeThread("grandchild-g", "child-c"),
      ],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: ThreadId.make("grandchild-g"),
    });

    expect(orderedIds(nodes)).toEqual(["parent-p", "grandchild-g"]);
    // Surfaced at its true depth (2), not collapsed to the parent's level.
    expect(nodes[1]!.depth).toBe(2);
  });

  it("rolls up the highest-priority subtree status, failed over completed", () => {
    const statusById: Record<string, ThreadStatusPill | null> = {
      "parent-p": null,
      "child-completed": COMPLETED_PILL,
      "child-failed": FAILED_PILL,
    };
    const nodes = buildSidebarThreadTree({
      threads: [
        treeThread("parent-p", null),
        treeThread("child-completed", "parent-p"),
        treeThread("child-failed", "parent-p"),
      ],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
      resolveStatus: (thread) => statusById[thread.id] ?? null,
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.subtreeStatus).toMatchObject({ label: "Failed" });
  });

  it("rolls a running descendant up over a completed sibling", () => {
    const statusById: Record<string, ThreadStatusPill | null> = {
      "parent-p": COMPLETED_PILL,
      "child-working": WORKING_PILL,
    };
    const nodes = buildSidebarThreadTree({
      threads: [treeThread("parent-p", null), treeThread("child-working", "parent-p")],
      expandedThreadIds: expandedSet(),
      pinnedThreadId: null,
      resolveStatus: (thread) => statusById[thread.id] ?? null,
    });

    expect(nodes[0]!.subtreeStatus).toMatchObject({ label: "Working" });
  });
});

describe("sliceSidebarThreadTreeToPreview", () => {
  const threeRootsWithChild = [
    treeThread("root-1", null),
    treeThread("child-1", "root-1"),
    treeThread("root-2", null),
    treeThread("root-3", null),
  ];

  function buildNodes(pinnedThreadId: ThreadId | null = null) {
    return buildSidebarThreadTree({
      threads: threeRootsWithChild,
      expandedThreadIds: expandedSet("root-1"),
      pinnedThreadId,
    });
  }

  it("counts roots only, so an expanded root's descendants do not consume budget", () => {
    const { rendered, hidden, hasHiddenRoots } = sliceSidebarThreadTreeToPreview({
      nodes: buildNodes(),
      previewLimit: 2,
      activeThreadId: null,
      isExpanded: false,
    });

    expect(hasHiddenRoots).toBe(true);
    // root-1 + child-1 + root-2 rendered (2 roots), root-3 hidden.
    expect(orderedIds(rendered)).toEqual(["root-1", "child-1", "root-2"]);
    expect(orderedIds(hidden)).toEqual(["root-3"]);
  });

  it("keeps the active thread's root block visible past the budget", () => {
    const { rendered, hidden } = sliceSidebarThreadTreeToPreview({
      nodes: buildNodes(),
      previewLimit: 1,
      activeThreadId: ThreadId.make("root-3"),
      isExpanded: false,
    });

    expect(orderedIds(rendered)).toEqual(["root-1", "child-1", "root-3"]);
    expect(orderedIds(hidden)).toEqual(["root-2"]);
  });

  it("renders everything when the thread list is expanded", () => {
    const { rendered, hidden } = sliceSidebarThreadTreeToPreview({
      nodes: buildNodes(),
      previewLimit: 1,
      activeThreadId: null,
      isExpanded: true,
    });

    expect(orderedIds(rendered)).toEqual(["root-1", "child-1", "root-2", "root-3"]);
    expect(hidden).toEqual([]);
  });
});

describe("tree order feeds flat-order consumers", () => {
  const threads = [
    treeThread("parent-p", null),
    treeThread("child-c", "parent-p"),
    treeThread("root-other", null),
  ];
  const visibleKeys = orderedIds(
    buildSidebarThreadTree({
      threads,
      expandedThreadIds: expandedSet("parent-p"),
      pinnedThreadId: null,
    }),
  );

  it("resolveAdjacentThreadId walks the flattened tree order", () => {
    expect(visibleKeys).toEqual(["parent-p", "child-c", "root-other"]);
    expect(
      resolveAdjacentThreadId({
        threadIds: visibleKeys,
        currentThreadId: "parent-p",
        direction: "next",
      }),
    ).toBe("child-c");
    expect(
      resolveAdjacentThreadId({
        threadIds: visibleKeys,
        currentThreadId: "root-other",
        direction: "previous",
      }),
    ).toBe("child-c");
  });

  it("range selection over the flattened tree order includes nested rows", () => {
    const store = useThreadSelectionStore.getState();
    store.clearSelection();
    store.setAnchor("parent-p");
    useThreadSelectionStore.getState().rangeSelectTo("root-other", visibleKeys);

    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      "parent-p",
      "child-c",
      "root-other",
    ]);
    useThreadSelectionStore.getState().clearSelection();
  });
});

describe("hasUnseenFailure", () => {
  const erroredTurn: OrchestrationLatestTurn = { ...makeLatestTurn(), state: "error" };

  it("returns true when a turn errored after the last visit", () => {
    expect(
      hasUnseenFailure({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: erroredTurn,
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });

  it("returns false once the failed thread has been visited", () => {
    expect(
      hasUnseenFailure({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: erroredTurn,
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
        session: null,
      }),
    ).toBe(false);
  });

  it("returns false for a non-error latest turn", () => {
    expect(
      hasUnseenFailure({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadStatusPill failed state", () => {
  const settledErrorThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: { ...makeLatestTurn(), state: "error" as const },
    lastVisitedAt: "2026-03-09T10:04:00.000Z",
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "ready" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows Failed for an unseen errored turn", () => {
    expect(resolveThreadStatusPill({ thread: settledErrorThread })).toMatchObject({
      label: "Failed",
      pulse: false,
    });
  });

  it("ranks Pending Approval above Failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...settledErrorThread, hasPendingApprovals: true },
      }),
    ).toMatchObject({ label: "Pending Approval" });
  });

  it("ranks Failed above Awaiting Input", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...settledErrorThread, hasPendingUserInput: true },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("rolls Failed up over Completed via resolveProjectStatusIndicator", () => {
    expect(resolveProjectStatusIndicator([COMPLETED_PILL, FAILED_PILL])).toMatchObject({
      label: "Failed",
    });
  });
});
