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
