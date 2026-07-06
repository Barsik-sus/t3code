import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  ChildSignalReactor,
  type ChildSignalReactorShape,
} from "../Services/ChildSignalReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

type ChildCreatedEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;
type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

const CHILD_CREATED_SUMMARY = (title: string) => `Sub-thread created: ${title}`;
const CHILD_SETTLED_SUMMARY = (title: string, state: string) =>
  `Sub-thread settled: ${title} (${state})`;
const CHILD_BLOCKED_SUMMARY = (title: string, reason: "approval" | "user-input") =>
  `Sub-thread blocked: ${title} (${reason})`;
const CHILD_FAILED_SUMMARY = (title: string) => `Sub-thread failed: ${title}`;

const STEER_SETTLED_MESSAGE = (title: string, childThreadId: ThreadId, state: string) =>
  `[t3code] Sub-thread "${title}" (${childThreadId}) settled: ${state}`;
const STEER_APPROVAL_MESSAGE = (title: string, childThreadId: ThreadId) =>
  `[t3code] Sub-thread "${title}" (${childThreadId}) is waiting on an approval`;
const STEER_QUESTIONS_MESSAGE = (title: string, childThreadId: ThreadId, count: number) =>
  `[t3code] Sub-thread "${title}" (${childThreadId}) is waiting on ${count} ${
    count === 1 ? "question" : "questions"
  }`;
const STEER_FAILED_MESSAGE = (title: string, childThreadId: ThreadId, detail: string) =>
  `[t3code] Sub-thread "${title}" (${childThreadId}) failed: ${detail}`;

const payloadRecord = (activity: OrchestrationThreadActivity): Record<string, unknown> =>
  typeof activity.payload === "object" &&
  activity.payload !== null &&
  !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : {};

const shortDetail = (detail: string): string => detail.trim().slice(0, 240);

const hasActivity = (
  parent: OrchestrationThread,
  predicate: (activity: OrchestrationThreadActivity, payload: Record<string, unknown>) => boolean,
): boolean => parent.activities.some((activity) => predicate(activity, payloadRecord(activity)));

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const projectionThreads = yield* ProjectionThreadRepository;
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`child-signal:${tag}:${uuid}`)));
  const eventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const messageId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`child-signal:${uuid}`)));

  const getThread = (threadId: ThreadId) => engine.getThreadSnapshot(threadId);

  const appendParentActivity = (input: {
    readonly parentThreadId: ThreadId;
    readonly kind:
      | "thread.child.created"
      | "thread.child.turn-settled"
      | "thread.child.blocked"
      | "thread.child.failed";
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: commandId("activity"),
      activityId: eventId(),
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.parentThreadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
      Effect.asVoid,
    );

  const maybeSteer = Effect.fn("ChildSignalReactor.maybeSteer")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly child: OrchestrationThread;
    readonly message: string;
    readonly createdAt: string;
  }) {
    const row = yield* projectionThreads.getById({ threadId: input.child.id });
    if (Option.isNone(row) || row.value.notifyMode !== "steer") {
      return;
    }
    const parent = yield* getThread(input.parentThreadId);
    if (!parent || parent.deletedAt !== null || parent.archivedAt !== null) {
      return;
    }
    // A turn.start on a session with a live running turn is queued into that
    // turn (steer); on an idle session it starts a new turn, so a creator
    // that ended its turn still learns about the child signal.
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("steer"),
      threadId: input.parentThreadId,
      message: {
        messageId: yield* messageId(),
        role: "user",
        text: input.message,
        attachments: [],
      },
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      createdAt: input.createdAt,
    });
  });

  const processChildCreated = Effect.fn("ChildSignalReactor.processChildCreated")(function* (
    event: ChildCreatedEvent,
  ) {
    const parentThreadId = event.payload.parentThreadId ?? null;
    if (parentThreadId === null) return;
    const parent = yield* getThread(parentThreadId);
    if (!parent) return;
    if (
      hasActivity(
        parent,
        (activity, payload) =>
          activity.kind === "thread.child.created" &&
          payload.childThreadId === event.payload.threadId,
      )
    ) {
      return;
    }
    yield* appendParentActivity({
      parentThreadId,
      kind: "thread.child.created",
      summary: CHILD_CREATED_SUMMARY(event.payload.title),
      payload: {
        childThreadId: event.payload.threadId,
        childTitle: event.payload.title,
      },
      tone: "info",
      turnId: null,
      createdAt: event.occurredAt,
    });
  });

  // The engine's in-memory read model is updated as part of dispatch, so it
  // is normally already settled when the session-set event arrives; the short
  // retry only covers residual publish-versus-projection ordering.
  const getSettledChild = Effect.fn("ChildSignalReactor.getSettledChild")(function* (
    threadId: ThreadId,
  ) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const child = yield* getThread(threadId);
      if (!child || child.parentThreadId === null) return undefined;
      if (child.latestTurn !== null && child.latestTurn.state !== "running") {
        return child;
      }
      yield* Effect.sleep("100 millis");
    }
    yield* Effect.logWarning("child settlement never became visible in the projection", {
      threadId,
    });
    return undefined;
  });

  const processSettlement = Effect.fn("ChildSignalReactor.processSettlement")(function* (
    event: ThreadSessionSetEvent,
  ) {
    if (event.payload.session.status === "running") return;
    const child = yield* getSettledChild(event.payload.threadId);
    if (!child || child.parentThreadId === null || child.latestTurn === null) return;
    const parent = yield* getThread(child.parentThreadId);
    if (!parent) return;
    const turnId = child.latestTurn.turnId;
    if (
      hasActivity(
        parent,
        (activity, payload) =>
          activity.kind === "thread.child.turn-settled" &&
          payload.childThreadId === child.id &&
          payload.turnId === turnId,
      )
    ) {
      return;
    }
    const errorDetail = child.session?.lastError ?? event.payload.session.lastError ?? undefined;
    yield* appendParentActivity({
      parentThreadId: child.parentThreadId,
      kind: "thread.child.turn-settled",
      summary: CHILD_SETTLED_SUMMARY(child.title, child.latestTurn.state),
      payload: {
        childThreadId: child.id,
        childTitle: child.title,
        turnId,
        state: child.latestTurn.state,
        ...(child.latestTurn.assistantMessageId !== null
          ? { assistantMessageId: child.latestTurn.assistantMessageId }
          : {}),
        ...(errorDetail ? { errorDetail } : {}),
      },
      tone: child.latestTurn.state === "error" ? "error" : "info",
      turnId: null,
      createdAt: event.occurredAt,
    });
    if (child.latestTurn.state === "error" && errorDetail) {
      yield* maybeSteer({
        parentThreadId: child.parentThreadId,
        child,
        message: STEER_FAILED_MESSAGE(child.title, child.id, shortDetail(errorDetail)),
        createdAt: event.occurredAt,
      });
    } else {
      yield* maybeSteer({
        parentThreadId: child.parentThreadId,
        child,
        message: STEER_SETTLED_MESSAGE(child.title, child.id, child.latestTurn.state),
        createdAt: event.occurredAt,
      });
    }
  });

  const processBlocked = Effect.fn("ChildSignalReactor.processBlocked")(function* (
    event: ThreadActivityAppendedEvent,
  ) {
    const activity = event.payload.activity;
    if (activity.kind !== "approval.requested" && activity.kind !== "user-input.requested") {
      if (activity.kind !== "provider.turn.start.failed") return;
      const child = yield* getThread(event.payload.threadId);
      if (!child || child.parentThreadId === null) return;
      const parent = yield* getThread(child.parentThreadId);
      if (!parent) return;
      const failurePayload = payloadRecord(activity);
      const detail =
        typeof failurePayload.detail === "string"
          ? shortDetail(failurePayload.detail)
          : activity.summary;
      if (
        hasActivity(
          parent,
          (parentActivity, payload) =>
            parentActivity.kind === "thread.child.failed" &&
            payload.childThreadId === child.id &&
            payload.detail === detail,
        )
      ) {
        return;
      }
      yield* appendParentActivity({
        parentThreadId: child.parentThreadId,
        kind: "thread.child.failed",
        summary: CHILD_FAILED_SUMMARY(child.title),
        payload: {
          childThreadId: child.id,
          childTitle: child.title,
          detail,
        },
        tone: "error",
        turnId: null,
        createdAt: event.occurredAt,
      });
      yield* maybeSteer({
        parentThreadId: child.parentThreadId,
        child,
        message: STEER_FAILED_MESSAGE(child.title, child.id, detail),
        createdAt: event.occurredAt,
      });
      return;
    }

    const child = yield* getThread(event.payload.threadId);
    if (!child || child.parentThreadId === null) return;
    const parent = yield* getThread(child.parentThreadId);
    if (!parent) return;
    const payload = payloadRecord(activity);
    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    if (!requestId) return;
    const reason = activity.kind === "approval.requested" ? "approval" : "user-input";
    if (
      hasActivity(
        parent,
        (parentActivity, parentPayload) =>
          parentActivity.kind === "thread.child.blocked" &&
          parentPayload.childThreadId === child.id &&
          parentPayload.requestId === requestId,
      )
    ) {
      return;
    }
    yield* appendParentActivity({
      parentThreadId: child.parentThreadId,
      kind: "thread.child.blocked",
      summary: CHILD_BLOCKED_SUMMARY(child.title, reason),
      payload: {
        childThreadId: child.id,
        childTitle: child.title,
        reason,
        requestId,
      },
      tone: "info",
      turnId: null,
      createdAt: event.occurredAt,
    });
    const questionCount = Array.isArray(payload.questions) ? payload.questions.length : 1;
    yield* maybeSteer({
      parentThreadId: child.parentThreadId,
      child,
      message:
        reason === "approval"
          ? STEER_APPROVAL_MESSAGE(child.title, child.id)
          : STEER_QUESTIONS_MESSAGE(child.title, child.id, questionCount),
      createdAt: event.occurredAt,
    });
  });

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.created":
        return processChildCreated(event);
      case "thread.session-set":
        return processSettlement(event);
      case "thread.activity-appended":
        return processBlocked(event);
      default:
        return Effect.void;
    }
  };

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("child signal reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: ChildSignalReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => worker.enqueue(event)),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ChildSignalReactorShape;
});

export const ChildSignalReactorLive = Layer.effect(ChildSignalReactor, make);

/** Exposed for tests. */
export const makeChildSignalReactorForTest = make;

export const __testing = {
  CHILD_CREATED_SUMMARY,
  CHILD_SETTLED_SUMMARY,
  CHILD_BLOCKED_SUMMARY,
  CHILD_FAILED_SUMMARY,
  STEER_SETTLED_MESSAGE,
  STEER_APPROVAL_MESSAGE,
  STEER_QUESTIONS_MESSAGE,
  STEER_FAILED_MESSAGE,
  hasActivity,
};
