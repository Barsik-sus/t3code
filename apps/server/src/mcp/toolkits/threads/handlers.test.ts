import {
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  TurnId,
  EventId,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it as vitestIt } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import { __testing } from "./handlers.ts";

const parentThreadId = ThreadId.make("thread-parent");
const childThreadId = ThreadId.make("thread-child");
const otherThreadId = ThreadId.make("thread-other");
const projectId = ProjectId.make("project-threads-toolkit-test");
const assistantMessageId = MessageId.make("message-assistant");
const turnId = TurnId.make("turn-child");
const eventId = (value: string) => EventId.make(value);

const makeThread = (patch: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: childThreadId,
    projectId,
    title: "Child thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/workspace",
    parentThreadId,
    origin: {
      kind: "agent",
      creatorThreadId: parentThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "provider-session",
    },
    notify: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    session: null,
    latestTurn: null,
    ...patch,
  }) as OrchestrationThread;

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  models: [
    {
      slug: "gpt-test",
      name: "GPT Test",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          { id: "fast", label: "Fast", type: "boolean" },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

describe("threads MCP toolkit helpers", () => {
  vitestIt("recognizes only direct agent-created children", () => {
    expect(__testing.hasCreator(makeThread(), parentThreadId)).toBe(true);
    expect(__testing.hasCreator(makeThread(), otherThreadId)).toBe(false);
    expect(
      __testing.hasCreator(
        makeThread({ origin: { kind: "user" } as OrchestrationThread["origin"] }),
        parentThreadId,
      ),
    ).toBe(false);
  });

  effectIt.effect("lists valid provider choices in validation failures", () =>
    Effect.gen(function* () {
      const invalidProvider = yield* Effect.exit(
        __testing.validateModelSelection([provider], {
          instanceId: ProviderInstanceId.make("missing"),
          model: "gpt-test",
          options: [],
        }),
      );
      if (!Exit.isFailure(invalidProvider)) {
        throw new Error("Expected invalid provider selection to fail.");
      }
      expect(Cause.pretty(invalidProvider.cause)).toContain("codex");

      const invalidOption = yield* Effect.exit(
        __testing.validateModelSelection([provider], {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-test",
          options: [{ id: "effort", value: "medium" }],
        }),
      );
      if (!Exit.isFailure(invalidOption)) {
        throw new Error("Expected invalid model option to fail.");
      }
      const failureText = Cause.pretty(invalidOption.cause);
      expect(failureText).toContain("low");
      expect(failureText).toContain("high");
    }),
  );

  vitestIt("returns full pending request payloads and suppresses resolved approvals", () => {
    const requests = __testing.getPendingRequests(
      makeThread({
        activities: [
          {
            id: eventId("activity-approval"),
            tone: "info",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-1", command: "write" },
            turnId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: eventId("activity-approval-resolved"),
            tone: "info",
            kind: "approval.resolved",
            summary: "Approval resolved",
            payload: { requestId: "approval-1" },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: eventId("activity-question"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Question requested",
            payload: {
              requestId: "question-1",
              questions: [{ id: "q1", prompt: "Value?" }],
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ],
      }),
    );

    expect(requests.approvals).toEqual([]);
    expect(requests.questions).toEqual([
      {
        requestId: "question-1",
        questions: [{ id: "q1", prompt: "Value?" }],
      },
    ]);
  });

  vitestIt("classifies settled, blocked, and pending child states", () => {
    const settled = __testing.classifyChildThread(
      makeThread({
        messages: [
          {
            id: assistantMessageId,
            role: "assistant",
            text: "Final answer",
            attachments: [],
            turnId,
            streaming: false,
            createdAt: "2026-01-01T00:00:04.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        session: {
          threadId: childThreadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-01-01T00:00:03.000Z",
          startedAt: "2026-01-01T00:00:03.000Z",
          completedAt: "2026-01-01T00:00:04.000Z",
          assistantMessageId,
        },
      }),
      turnId,
    );
    expect(settled).toMatchObject({
      kind: "settled",
      settled: { turnId, state: "completed", finalMessage: "Final answer" },
    });

    const blocked = __testing.classifyChildThread(
      makeThread({
        activities: [
          {
            id: eventId("activity-approval-blocked"),
            tone: "info",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-1" },
            turnId: null,
            createdAt: "2026-01-01T00:00:05.000Z",
          },
        ],
      }),
    );
    expect(blocked).toMatchObject({ kind: "blocked" });

    const pending = __testing.classifyChildThread(
      makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-01-01T00:00:03.000Z",
          startedAt: "2026-01-01T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    expect(pending).toEqual({ kind: "pending" });
  });
});

describe("runtime mode descriptions", () => {
  vitestIt("stay pinned to the codex sandbox mapping", async () => {
    const { RUNTIME_MODE_DESCRIPTIONS } = await import("./handlers.ts");
    const { runtimeModeToThreadConfig } =
      await import("../../../provider/Layers/CodexSessionRuntime.ts");
    const claims = {
      "approval-required": "read-only sandbox",
      "auto-accept-edits": "workspace-write sandbox",
      "full-access": "full system access",
    } as const;
    const sandboxByClaim = {
      "read-only sandbox": "read-only",
      "workspace-write sandbox": "workspace-write",
      "full system access": "danger-full-access",
    } as const;
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      const claim = claims[mode];
      expect(RUNTIME_MODE_DESCRIPTIONS[mode]).toContain(claim);
      expect(runtimeModeToThreadConfig(mode).sandbox).toBe(sandboxByClaim[claim]);
    }
  });
});
