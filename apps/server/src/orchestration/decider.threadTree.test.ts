import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const now = "2026-01-01T00:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: OrchestrationEvent["aggregateId"];
  readonly commandId: CommandId;
  readonly payload: OrchestrationEvent["payload"];
  readonly occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: asEventId(`evt-${input.sequence}`),
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    type: input.type,
    occurredAt: input.occurredAt ?? now,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: {},
    payload: input.payload,
  } as OrchestrationEvent;
}

function projectCreated(sequence: number, projectId: ProjectId): OrchestrationEvent {
  return makeEvent({
    sequence,
    type: "project.created",
    aggregateKind: "project",
    aggregateId: projectId,
    commandId: asCommandId(`cmd-project-${projectId}`),
    payload: {
      projectId,
      title: `Project ${projectId}`,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
}

function threadCreated(input: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly parentThreadId?: ThreadId | null;
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.sequence,
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: input.threadId,
    commandId: asCommandId(`cmd-create-${input.threadId}`),
    payload: {
      threadId: input.threadId,
      projectId: input.projectId ?? asProjectId("project-tree"),
      title: `Thread ${input.threadId}`,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      parentThreadId: input.parentThreadId ?? null,
      origin: { kind: "user" },
      notify: "none",
      createdAt: now,
      updatedAt: now,
    },
  });
}

function threadDeleted(sequence: number, threadId: ThreadId): OrchestrationEvent {
  return makeEvent({
    sequence,
    type: "thread.deleted",
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: asCommandId(`cmd-delete-${threadId}`),
    payload: {
      threadId,
      deletedAt: "2026-01-01T00:00:01.000Z",
    },
  });
}

function threadArchived(input: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly cascadedFrom?: ThreadId | null;
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.sequence,
    type: "thread.archived",
    aggregateKind: "thread",
    aggregateId: input.threadId,
    commandId: asCommandId(`cmd-archive-${input.threadId}`),
    payload: {
      threadId: input.threadId,
      archivedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      cascadedFrom: input.cascadedFrom ?? null,
    },
  });
}

function createThreadCommand(input: {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly parentThreadId?: ThreadId | null;
}): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: asCommandId(`cmd-create-new-${input.threadId}`),
    threadId: input.threadId,
    projectId: input.projectId ?? asProjectId("project-tree"),
    title: `Thread ${input.threadId}`,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    parentThreadId: input.parentThreadId ?? null,
    origin: { kind: "user" },
    notify: "none",
    createdAt: now,
  };
}

const projectReadModel = projectEvent(
  createEmptyReadModel(now),
  projectCreated(1, asProjectId("project-tree")),
).pipe(
  Effect.flatMap((readModel) =>
    projectEvent(readModel, projectCreated(2, asProjectId("project-other"))),
  ),
);

const treeReadModel = Effect.gen(function* () {
  let readModel = yield* projectReadModel;
  for (const event of [
    threadCreated({ sequence: 3, threadId: asThreadId("thread-root") }),
    threadCreated({
      sequence: 4,
      threadId: asThreadId("thread-child-a"),
      parentThreadId: asThreadId("thread-root"),
    }),
    threadCreated({
      sequence: 5,
      threadId: asThreadId("thread-grandchild"),
      parentThreadId: asThreadId("thread-child-a"),
    }),
    threadCreated({
      sequence: 6,
      threadId: asThreadId("thread-great-grandchild"),
      parentThreadId: asThreadId("thread-grandchild"),
    }),
    threadCreated({
      sequence: 7,
      threadId: asThreadId("thread-child-b"),
      parentThreadId: asThreadId("thread-root"),
    }),
  ]) {
    readModel = yield* projectEvent(readModel, event);
  }
  return readModel;
});

function plannedEvents(result: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  return Array.isArray(result) ? result : [result];
}

function threadIds(events: ReadonlyArray<PlannedEvent>) {
  return events.map((event) => event.aggregateId);
}

function applyPlannedEvents(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<PlannedEvent>,
) {
  return Effect.gen(function* () {
    let nextReadModel = readModel;
    let nextSequence = readModel.snapshotSequence;
    for (const event of events) {
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...event,
        sequence: nextSequence,
      } as OrchestrationEvent);
    }
    return nextReadModel;
  });
}

it.layer(NodeServices.layer)("thread tree decider rules", (it) => {
  it.effect("allows creating a child thread under an existing same-project parent", () =>
    Effect.gen(function* () {
      const readModel = yield* treeReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: createThreadCommand({
          threadId: asThreadId("thread-new-child"),
          parentThreadId: asThreadId("thread-root"),
        }),
      });
      const event = plannedEvents(result)[0];

      expect(event?.type).toBe("thread.created");
      expect(event?.payload).toMatchObject({
        threadId: asThreadId("thread-new-child"),
        parentThreadId: asThreadId("thread-root"),
        projectId: asProjectId("project-tree"),
      });
    }),
  );

  it.effect("rejects child creation when the parent is missing", () =>
    Effect.gen(function* () {
      const readModel = yield* projectReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: createThreadCommand({
            threadId: asThreadId("thread-new-child"),
            parentThreadId: asThreadId("thread-missing"),
          }),
        }),
      );

      expect(error.message).toContain("Parent thread 'thread-missing' does not exist");
    }),
  );

  it.effect("rejects child creation when the parent is deleted", () =>
    Effect.gen(function* () {
      let readModel = yield* projectReadModel;
      readModel = yield* projectEvent(
        readModel,
        threadCreated({ sequence: 3, threadId: asThreadId("thread-deleted-parent") }),
      );
      readModel = yield* projectEvent(
        readModel,
        threadDeleted(4, asThreadId("thread-deleted-parent")),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: createThreadCommand({
            threadId: asThreadId("thread-new-child"),
            parentThreadId: asThreadId("thread-deleted-parent"),
          }),
        }),
      );

      expect(error.message).toContain("is deleted and cannot parent");
    }),
  );

  it.effect("rejects child creation when the parent belongs to a different project", () =>
    Effect.gen(function* () {
      let readModel = yield* projectReadModel;
      readModel = yield* projectEvent(
        readModel,
        threadCreated({
          sequence: 3,
          threadId: asThreadId("thread-other-project-parent"),
          projectId: asProjectId("project-other"),
        }),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: createThreadCommand({
            threadId: asThreadId("thread-new-child"),
            parentThreadId: asThreadId("thread-other-project-parent"),
          }),
        }),
      );

      expect(error.message).toContain("belongs to project 'project-other'");
    }),
  );

  it.effect("deletes descendants before their parent across depth three", () =>
    Effect.gen(function* () {
      const readModel = yield* treeReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-delete-root"),
          threadId: asThreadId("thread-root"),
        },
      });

      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "thread.deleted",
        "thread.deleted",
        "thread.deleted",
      ]);
      expect(threadIds(events)).toEqual([
        asThreadId("thread-great-grandchild"),
        asThreadId("thread-grandchild"),
        asThreadId("thread-child-a"),
        asThreadId("thread-child-b"),
        asThreadId("thread-root"),
      ]);
    }),
  );

  it.effect("archives descendants with the acted-on ancestor as cascadedFrom", () =>
    Effect.gen(function* () {
      const readModel = yield* treeReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-root"),
          threadId: asThreadId("thread-root"),
        },
      });

      const events = plannedEvents(result);
      expect(threadIds(events)).toEqual([
        asThreadId("thread-great-grandchild"),
        asThreadId("thread-grandchild"),
        asThreadId("thread-child-a"),
        asThreadId("thread-child-b"),
        asThreadId("thread-root"),
      ]);
      expect(
        events.map((event) =>
          event.type === "thread.archived" ? event.payload.cascadedFrom : undefined,
        ),
      ).toEqual([
        asThreadId("thread-root"),
        asThreadId("thread-root"),
        asThreadId("thread-root"),
        asThreadId("thread-root"),
        null,
      ]);
    }),
  );

  it.effect("unarchives only descendants archived by the acted-on ancestor cascade", () =>
    Effect.gen(function* () {
      let readModel = yield* treeReadModel;
      readModel = yield* projectEvent(
        readModel,
        threadArchived({
          sequence: 8,
          threadId: asThreadId("thread-child-a"),
          cascadedFrom: null,
        }),
      );

      const archiveResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-root"),
          threadId: asThreadId("thread-root"),
        },
      });
      readModel = yield* applyPlannedEvents(readModel, plannedEvents(archiveResult));

      const unarchiveResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-unarchive-root"),
          threadId: asThreadId("thread-root"),
        },
      });

      const events = plannedEvents(unarchiveResult);
      expect(events.map((event) => event.type)).toEqual([
        "thread.unarchived",
        "thread.unarchived",
        "thread.unarchived",
        "thread.unarchived",
      ]);
      expect(threadIds(events)).toEqual([
        asThreadId("thread-great-grandchild"),
        asThreadId("thread-grandchild"),
        asThreadId("thread-child-b"),
        asThreadId("thread-root"),
      ]);

      const finalReadModel = yield* applyPlannedEvents(readModel, events);
      const childA = finalReadModel.threads.find((thread) => thread.id === "thread-child-a");
      const grandchild = finalReadModel.threads.find((thread) => thread.id === "thread-grandchild");
      expect(childA?.archivedAt).not.toBeNull();
      expect(grandchild?.archivedAt).toBeNull();
    }),
  );
});
