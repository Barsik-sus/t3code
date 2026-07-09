import { EventId, ThreadId, TurnId, type OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { __testing } from "./ChildSignalReactor.ts";

const childThreadId = ThreadId.make("thread-child");
const turnId = TurnId.make("turn-child");

describe("ChildSignalReactor helpers", () => {
  it("uses neutral activity and steer message templates", () => {
    const title = "Investigate test failure";
    const messages = [
      __testing.CHILD_CREATED_SUMMARY(title),
      __testing.CHILD_SETTLED_SUMMARY(title, "completed"),
      __testing.CHILD_BLOCKED_SUMMARY(title, "approval"),
      __testing.CHILD_FAILED_SUMMARY(title),
      __testing.STEER_SETTLED_MESSAGE(title, childThreadId, "completed"),
      __testing.STEER_APPROVAL_MESSAGE(title, childThreadId),
      __testing.STEER_QUESTIONS_MESSAGE(title, childThreadId, 2),
      __testing.STEER_FAILED_MESSAGE(title, childThreadId, "Provider turn start failed"),
    ];

    expect(messages).toEqual([
      "Sub-thread created: Investigate test failure",
      "Sub-thread settled: Investigate test failure (completed)",
      "Sub-thread blocked: Investigate test failure (approval)",
      "Sub-thread failed: Investigate test failure",
      '[t3code] Sub-thread "Investigate test failure" (thread-child) settled: completed',
      '[t3code] Sub-thread "Investigate test failure" (thread-child) is waiting on an approval',
      '[t3code] Sub-thread "Investigate test failure" (thread-child) is waiting on 2 questions',
      '[t3code] Sub-thread "Investigate test failure" (thread-child) failed: Provider turn start failed',
    ]);
    expect(messages.join("\n")).not.toMatch(/\bshould\b|\bprefer\b|\bescalate\b/i);
  });

  it("matches existing child signal activities by child and request or turn id", () => {
    const parent = {
      activities: [
        {
          id: EventId.make("activity-settled"),
          tone: "info",
          kind: "thread.child.turn-settled",
          summary: "Sub-thread settled: Child (completed)",
          payload: { childThreadId, turnId },
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: EventId.make("activity-blocked"),
          tone: "info",
          kind: "thread.child.blocked",
          summary: "Sub-thread blocked: Child (approval)",
          payload: { childThreadId, requestId: "approval-1" },
          turnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    } as unknown as OrchestrationThread;

    expect(
      __testing.hasActivity(
        parent,
        (activity, payload) =>
          activity.kind === "thread.child.turn-settled" &&
          payload.childThreadId === childThreadId &&
          payload.turnId === turnId,
      ),
    ).toBe(true);
    expect(
      __testing.hasActivity(
        parent,
        (activity, payload) =>
          activity.kind === "thread.child.blocked" &&
          payload.childThreadId === childThreadId &&
          payload.requestId === "approval-2",
      ),
    ).toBe(false);
  });
});

describe("ChildSignalReactor settlement", () => {
  const parentThreadId = ThreadId.make("thread-parent");

  const makeThread = (input: {
    id: ThreadId;
    parentThreadId: ThreadId | null;
    latestTurnState?: "running" | "completed";
    sessionStatus?: string | null;
  }): OrchestrationThread =>
    ({
      id: input.id,
      projectId: "project-1",
      title: "Fixture thread",
      parentThreadId: input.parentThreadId,
      origin:
        input.parentThreadId === null
          ? { kind: "user" }
          : { kind: "agent", creatorThreadId: input.parentThreadId },
      rootThreadId: input.parentThreadId ?? input.id,
      depth: input.parentThreadId === null ? 0 : 1,
      latestTurn:
        input.latestTurnState === undefined
          ? null
          : {
              turnId,
              state: input.latestTurnState,
              requestedAt: "2026-01-01T00:00:00.000Z",
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: input.latestTurnState === "running" ? null : "2026-01-01T00:00:01.000Z",
              assistantMessageId: null,
            },
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session:
        input.sessionStatus === undefined || input.sessionStatus === null
          ? null
          : { status: input.sessionStatus, lastError: null },
    }) as unknown as OrchestrationThread;

  it("appends the settled activity once the projection catches up, and starts a turn on an idle steer parent", async () => {
    const { makeChildSignalReactorForTest } = await import("./ChildSignalReactor.ts");
    const Effect = await import("effect/Effect");
    const Option = await import("effect/Option");
    const Layer = await import("effect/Layer");
    const Stream = await import("effect/Stream");
    const ManagedRuntime = await import("effect/ManagedRuntime");
    const { OrchestrationEngineService } = await import("../Services/OrchestrationEngine.ts");
    const { ProjectionThreadRepository } =
      await import("../../persistence/Services/ProjectionThreads.ts");
    const { ChildSignalReactor: ChildSignalReactorTag } =
      await import("../Services/ChildSignalReactor.ts");

    const dispatched: Array<{ type: string }> = [];
    // The projection lags: the first two reads still show the child running.
    let childReads = 0;
    const sessionSetEvent = {
      type: "thread.session-set",
      eventId: EventId.make("event-1"),
      aggregateKind: "thread",
      aggregateId: childThreadId,
      occurredAt: "2026-01-01T00:00:01.000Z",
      sequence: 1,
      commandId: "command-1",
      causationEventId: null,
      payload: {
        threadId: childThreadId,
        session: { status: "ready", lastError: null },
      },
    } as never;

    const engineStub = {
      dispatch: (command: { type: string }) => {
        dispatched.push(command);
        return Effect.void;
      },
      streamDomainEvents: Stream.make(sessionSetEvent),
      getThreadSnapshot: (threadId: ThreadId) => {
        if (threadId === childThreadId) {
          childReads += 1;
          return Effect.succeed(
            makeThread({
              id: childThreadId,
              parentThreadId,
              latestTurnState: childReads <= 2 ? "running" : "completed",
              sessionStatus: "ready",
            }),
          );
        }
        return Effect.succeed(
          makeThread({
            id: parentThreadId,
            parentThreadId: null,
            sessionStatus: "ready", // idle: no running turn
          }),
        );
      },
    };
    const projectionThreadsStub = {
      getById: () => Effect.succeed(Option.some({ threadId: childThreadId, notifyMode: "steer" })),
    };

    const Crypto = await import("effect/Crypto");
    let uuidCounter = 0;
    const cryptoStub = {
      randomUUIDv4: Effect.sync(() => {
        uuidCounter += 1;
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
      }),
    } as unknown as (typeof Crypto.Crypto)["Service"];

    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This test owns a long-lived runtime to exercise its stream reactor across imperative emissions.
    const runtime = ManagedRuntime.make(
      Layer.effect(ChildSignalReactorTag, makeChildSignalReactorForTest).pipe(
        Layer.provideMerge(Layer.succeed(Crypto.Crypto, cryptoStub)),
        Layer.provideMerge(
          Layer.succeed(
            OrchestrationEngineService,
            engineStub as unknown as (typeof OrchestrationEngineService)["Service"],
          ),
        ),
        Layer.provideMerge(
          Layer.succeed(
            ProjectionThreadRepository,
            projectionThreadsStub as unknown as (typeof ProjectionThreadRepository)["Service"],
          ),
        ),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ChildSignalReactorTag;
            yield* reactor.start();
            yield* Effect.sleep("50 millis");
            yield* reactor.drain;
          }),
        ),
      );
      const activityAppends = dispatched.filter(
        (command) => command.type === "thread.activity.append",
      );
      const turnStarts = dispatched.filter((command) => command.type === "thread.turn.start");
      expect(childReads).toBeGreaterThan(2);
      expect(activityAppends).toHaveLength(1);
      expect((activityAppends[0] as { activity?: { kind?: string } }).activity?.kind).toBe(
        "thread.child.turn-settled",
      );
      expect(turnStarts).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
