import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { dispatchThreadTurnBootstrap } from "../../../orchestration/Layers/ThreadTurnBootstrap.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ThreadsToolkit } from "./tools.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;
const INTERACTION_MODES = ["default", "plan"] as const;
const MAX_WAIT_SECONDS = 600;
const POLL_INTERVAL_MS = 250;

const fail = (message: string) => Effect.fail({ message });

const activityPayloadRecord = (activity: OrchestrationThreadActivity): Record<string, unknown> =>
  typeof activity.payload === "object" &&
  activity.payload !== null &&
  !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : {};

const trimTitle = (value: string): string => {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 0 ? firstLine : "Sub-thread";
  return title.slice(0, 80);
};

const hasCreator = (thread: OrchestrationThread, parentThreadId: ThreadId): boolean =>
  thread.origin.kind === "agent" && thread.origin.creatorThreadId === parentThreadId;

const providerIsAvailable = (provider: ServerProvider): boolean =>
  provider.enabled && provider.installed && provider.availability !== "unavailable";

const descriptorChoices = (descriptor: ProviderOptionDescriptor): ReadonlyArray<string> => {
  if (descriptor.type === "boolean") return ["true", "false"];
  return descriptor.options.map((option) => option.id);
};

const formatChoices = (choices: ReadonlyArray<string>) => choices.join(", ");

const validateModelSelection = (
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): Effect.Effect<void, { readonly message: string }> => {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (!provider || !providerIsAvailable(provider)) {
    const valid = providers.filter(providerIsAvailable).map((entry) => entry.instanceId);
    return fail(
      `Unknown provider instance '${selection.instanceId}'. Valid provider instances: ${formatChoices(valid)}.`,
    );
  }
  const model = provider.models.find((entry) => entry.slug === selection.model);
  if (!model) {
    const valid = provider.models.map((entry) => entry.slug);
    return fail(
      `Unknown model '${selection.model}' for provider instance '${selection.instanceId}'. Valid models: ${formatChoices(valid)}.`,
    );
  }

  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const descriptorById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  );
  for (const option of selection.options ?? []) {
    const descriptor = descriptorById.get(option.id);
    if (!descriptor) {
      return fail(
        `Unknown model option '${option.id}' for model '${selection.model}'. Valid options: ${formatChoices(descriptors.map((entry) => entry.id))}.`,
      );
    }
    if (descriptor.type === "boolean") {
      if (typeof option.value !== "boolean") {
        return fail(`Invalid value for model option '${option.id}'. Valid choices: true, false.`);
      }
    } else if (
      typeof option.value !== "string" ||
      !descriptor.options.some((choice) => choice.id === option.value)
    ) {
      return fail(
        `Invalid value '${String(option.value)}' for model option '${option.id}'. Valid choices: ${formatChoices(descriptorChoices(descriptor))}.`,
      );
    }
  }
  return Effect.void;
};

const getPendingRequests = (thread: OrchestrationThread) => {
  const resolvedApprovalIds = new Set<string>();
  const resolvedQuestionIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload = activityPayloadRecord(activity);
    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    if (!requestId) continue;
    if (activity.kind === "approval.resolved") resolvedApprovalIds.add(requestId);
    if (activity.kind === "user-input.resolved") resolvedQuestionIds.add(requestId);
    if (
      activity.kind === "provider.approval.respond.failed" &&
      typeof payload.detail === "string" &&
      (payload.detail.includes("Stale pending approval request") ||
        payload.detail.includes("Unknown pending approval request"))
    ) {
      resolvedApprovalIds.add(requestId);
    }
  }

  const approvals = thread.activities
    .filter((activity) => activity.kind === "approval.requested")
    .map((activity) => {
      const payload = activityPayloadRecord(activity);
      return {
        requestId: typeof payload.requestId === "string" ? payload.requestId : "",
        summary: activity.summary,
        payload,
      };
    })
    .filter(
      (request) => request.requestId.length > 0 && !resolvedApprovalIds.has(request.requestId),
    );

  const questions = thread.activities
    .filter((activity) => activity.kind === "user-input.requested")
    .map((activity) => {
      const payload = activityPayloadRecord(activity);
      return {
        requestId: typeof payload.requestId === "string" ? payload.requestId : "",
        questions: Array.isArray(payload.questions) ? payload.questions : [],
      };
    })
    .filter(
      (request) => request.requestId.length > 0 && !resolvedQuestionIds.has(request.requestId),
    );

  return { approvals, questions };
};

const classifyChildThread = (child: OrchestrationThread, requestedTurnId?: string) => {
  const pendingRequests = getPendingRequests(child);
  const blocked = [
    ...(pendingRequests.approvals.length > 0
      ? [
          {
            childThreadId: child.id,
            reason: "approval" as const,
            requests: pendingRequests.approvals,
          },
        ]
      : []),
    ...(pendingRequests.questions.length > 0
      ? [
          {
            childThreadId: child.id,
            reason: "user-input" as const,
            requests: pendingRequests.questions,
          },
        ]
      : []),
  ];
  if (blocked.length > 0) return { kind: "blocked" as const, blocked };
  const latestTurn = child.latestTurn;
  if (
    latestTurn &&
    latestTurn.state !== "running" &&
    (!requestedTurnId || latestTurn.turnId === requestedTurnId)
  ) {
    const finalMessage =
      latestTurn.assistantMessageId === null
        ? undefined
        : child.messages.find((message) => message.id === latestTurn.assistantMessageId)?.text;
    return {
      kind: "settled" as const,
      settled: {
        childThreadId: child.id,
        turnId: latestTurn.turnId,
        state: latestTurn.state,
        ...(finalMessage !== undefined ? { finalMessage } : {}),
        ...(child.session?.lastError ? { errorDetail: child.session.lastError } : {}),
      },
    };
  }
  return { kind: "pending" as const };
};

const makeHandlers = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`mcp:${tag}:${uuid}`)));
  const messageId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`mcp:${uuid}`)));

  const scope = () => McpInvocationContext.requireMcpCapability("threads");

  const getParentThread = Effect.fn("threads.getParentThread")(function* () {
    const invocation = yield* scope();
    const thread = yield* snapshots.getThreadDetailById(invocation.threadId);
    if (Option.isNone(thread)) {
      return yield* fail(`Thread '${invocation.threadId}' was not found.`);
    }
    return { invocation, parent: thread.value };
  });

  const getAuthorizedChild = Effect.fn("threads.getAuthorizedChild")(function* (
    childThreadId: string,
  ) {
    const { invocation } = yield* getParentThread();
    const childId = ThreadId.make(childThreadId);
    const child = yield* snapshots.getThreadDetailById(childId);
    if (Option.isNone(child)) {
      return yield* fail(`Sub-thread '${childThreadId}' was not found.`);
    }
    if (!hasCreator(child.value, invocation.threadId)) {
      return yield* fail(`Sub-thread '${childThreadId}' was not created by this agent session.`);
    }
    return { invocation, child: child.value };
  });

  const listAuthorizedChildren = Effect.fn("threads.listAuthorizedChildren")(function* () {
    const { invocation } = yield* getParentThread();
    const snapshot = yield* snapshots.getSnapshot();
    return snapshot.threads.filter(
      (thread) =>
        thread.parentThreadId === invocation.threadId && hasCreator(thread, invocation.threadId),
    );
  });

  const waitSnapshot = Effect.fn("threads.waitSnapshot")(function* (input: {
    readonly childIds: ReadonlyArray<ThreadId>;
    readonly mode: "any" | "all";
    readonly turnId?: string | undefined;
  }) {
    const settled: Array<unknown> = [];
    const blocked: Array<unknown> = [];
    const pending: Array<string> = [];
    let readyChildCount = 0;
    for (const childId of input.childIds) {
      const child = yield* snapshots.getThreadDetailById(childId);
      if (Option.isNone(child)) {
        pending.push(childId);
        continue;
      }
      const classification = classifyChildThread(child.value, input.turnId);
      if (classification.kind === "settled") {
        settled.push(classification.settled);
        readyChildCount += 1;
      } else if (classification.kind === "blocked") {
        blocked.push(...classification.blocked);
        readyChildCount += 1;
      } else {
        pending.push(childId);
      }
    }
    const shouldReturn =
      input.mode === "all" ? readyChildCount === input.childIds.length : readyChildCount > 0;
    return { shouldReturn, result: { settled, blocked, pending } };
  });

  return {
    create_child_thread: (input) =>
      Effect.gen(function* () {
        const { invocation, parent } = yield* getParentThread();
        const providerSnapshots = yield* providers.getProviders;
        const resolvedModelSelection = input.modelSelection ?? parent.modelSelection;
        yield* validateModelSelection(providerSnapshots, resolvedModelSelection);
        const createdAt = yield* now;
        const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
        const userMessageId = yield* messageId();
        const title = trimTitle(input.title ?? input.initialPrompt);
        const runtimeMode = input.runtimeMode ?? parent.runtimeMode;
        const interactionMode =
          input.interactionMode ?? parent.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
        const notify = input.notify ?? "none";
        const workspace = input.workspace ?? { placement: "parent" as const };
        const snapshot = yield* snapshots.getSnapshot();
        const project = snapshot.projects.find((entry) => entry.id === parent.projectId);
        if (!project) return yield* fail(`Project '${parent.projectId}' was not found.`);

        const placement = (() => {
          switch (workspace.placement) {
            case "parent":
              return { branch: parent.branch, worktreePath: parent.worktreePath };
            case "project-root":
              return { branch: null, worktreePath: project.workspaceRoot };
            case "new-worktree":
              return { branch: null, worktreePath: null };
          }
        })();

        const createThreadCommand: Extract<OrchestrationCommand, { type: "thread.create" }> = {
          type: "thread.create",
          commandId: yield* commandId("child-thread-create"),
          threadId: childThreadId,
          projectId: parent.projectId,
          title,
          modelSelection: resolvedModelSelection,
          runtimeMode,
          interactionMode,
          branch: placement.branch,
          worktreePath: placement.worktreePath,
          parentThreadId: invocation.threadId,
          origin: {
            kind: "agent",
            creatorThreadId: invocation.threadId,
            providerInstanceId: invocation.providerInstanceId,
            providerSessionId: invocation.providerSessionId,
            ...(parent.latestTurn?.turnId ? { creatorTurnId: parent.latestTurn.turnId } : {}),
          },
          notify,
          createdAt,
        };
        const turnStartCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
          type: "thread.turn.start",
          commandId: yield* commandId("child-turn-start"),
          threadId: childThreadId,
          message: {
            messageId: userMessageId,
            role: "user",
            text: input.initialPrompt,
            attachments: [],
          },
          modelSelection: resolvedModelSelection,
          // An explicit title is authoritative; auto-titling only seeds
          // threads whose title was derived from the initial prompt.
          ...(input.title === undefined ? { titleSeed: title } : {}),
          runtimeMode,
          interactionMode,
          createdAt,
        };

        const prepareWorktree =
          workspace.placement === "new-worktree"
            ? {
                projectCwd: project.workspaceRoot,
                baseBranch: workspace.baseBranch ?? parent.branch ?? "main",
                ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
                ...(workspace.startFromOrigin !== undefined
                  ? { startFromOrigin: workspace.startFromOrigin }
                  : {}),
              }
            : undefined;

        yield* dispatchThreadTurnBootstrap({
          turnStartCommand,
          createThreadCommand,
          ...(prepareWorktree ? { prepareWorktree } : {}),
          runSetupScript: workspace.placement === "new-worktree",
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(GitWorkflowService.GitWorkflowService, gitWorkflow),
          Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, vcsStatusBroadcaster),
          Effect.provideService(
            ProjectSetupScriptRunner.ProjectSetupScriptRunner,
            projectSetupScriptRunner,
          ),
        );
        return { childThreadId, title };
      }),

    list_thread_options: () =>
      Effect.gen(function* () {
        const { parent } = yield* getParentThread();
        const providerSnapshots = yield* providers.getProviders;
        return {
          providerInstances: providerSnapshots.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            displayName: provider.displayName ?? null,
            enabled: provider.enabled,
            installed: provider.installed,
            availability: provider.availability ?? "available",
            models: provider.models.map((model) => ({
              slug: model.slug,
              name: model.name,
              optionDescriptors: model.capabilities?.optionDescriptors ?? [],
            })),
          })),
          runtimeModes: [...RUNTIME_MODES],
          interactionModes: [...INTERACTION_MODES],
          defaults: {
            modelSelection: parent.modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
          },
        };
      }),

    list_child_threads: () =>
      listAuthorizedChildren().pipe(
        Effect.map((children) => ({
          children: children.map((child) => ({
            childThreadId: child.id,
            title: child.title,
            sessionStatus: child.session?.status ?? null,
            latestTurnId: child.latestTurn?.turnId ?? null,
            latestTurnState: child.latestTurn?.state ?? null,
            pendingApprovalCount: getPendingRequests(child).approvals.length,
            pendingQuestionCount: getPendingRequests(child).questions.length,
            createdAt: child.createdAt,
            updatedAt: child.updatedAt,
          })),
        })),
      ),

    wait_for_child_threads: (input) =>
      Effect.gen(function* () {
        yield* getParentThread();
        const children =
          input.childThreadIds && input.childThreadIds.length > 0
            ? yield* Effect.forEach(input.childThreadIds, (childId) =>
                getAuthorizedChild(childId).pipe(Effect.map(({ child }) => child)),
              )
            : yield* listAuthorizedChildren();
        if (input.turnId !== undefined && children.length !== 1) {
          return yield* fail(
            "turnId may be supplied only when exactly one childThreadId is watched.",
          );
        }
        const childIds = children.map((child) => child.id);
        const mode = input.mode ?? "any";
        const timeoutMs =
          Math.max(0, Math.min(input.timeoutSeconds ?? 60, MAX_WAIT_SECONDS)) * 1_000;
        const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
        let last = yield* waitSnapshot({ childIds, mode, turnId: input.turnId });
        while (!last.shouldReturn && (yield* Clock.currentTimeMillis) < deadline) {
          yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
          last = yield* waitSnapshot({ childIds, mode, turnId: input.turnId });
        }
        return last.result;
      }),

    get_child_pending_requests: (input) =>
      getAuthorizedChild(input.childThreadId).pipe(
        Effect.map(({ child }) => getPendingRequests(child)),
      ),

    respond_to_child_approval: (input) =>
      Effect.gen(function* () {
        const { child } = yield* getAuthorizedChild(input.childThreadId);
        const pending = getPendingRequests(child).approvals.some(
          (request) => request.requestId === input.requestId,
        );
        if (!pending) return { outcome: "already-resolved" as const };
        yield* engine.dispatch({
          type: "thread.approval.respond",
          commandId: yield* commandId("child-approval-respond"),
          threadId: child.id,
          requestId: ApprovalRequestId.make(input.requestId),
          decision: input.decision,
          createdAt: yield* now,
        });
        return { outcome: "applied" as const };
      }),

    respond_to_child_user_input: (input) =>
      Effect.gen(function* () {
        const { child } = yield* getAuthorizedChild(input.childThreadId);
        const pending = getPendingRequests(child).questions.some(
          (request) => request.requestId === input.requestId,
        );
        if (!pending) return { outcome: "already-resolved" as const };
        yield* engine.dispatch({
          type: "thread.user-input.respond",
          commandId: yield* commandId("child-user-input-respond"),
          threadId: child.id,
          requestId: ApprovalRequestId.make(input.requestId),
          answers: input.answers,
          createdAt: yield* now,
        });
        return { outcome: "applied" as const };
      }),

    interrupt_child_thread: (input) =>
      Effect.gen(function* () {
        const { child } = yield* getAuthorizedChild(input.childThreadId);
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("child-turn-interrupt"),
          threadId: child.id,
          ...(input.turnId !== undefined ? { turnId: TurnId.make(input.turnId) } : {}),
          createdAt: yield* now,
        });
        return { outcome: "requested" as const };
      }),

    send_to_child_thread: (input) =>
      Effect.gen(function* () {
        const { child } = yield* getAuthorizedChild(input.childThreadId);
        const providerSnapshots = yield* providers.getProviders;
        if (input.modelSelection !== undefined) {
          yield* validateModelSelection(providerSnapshots, input.modelSelection);
        }
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("child-follow-up-turn-start"),
          threadId: child.id,
          message: {
            messageId: yield* messageId(),
            role: "user",
            text: input.message,
            attachments: [],
          },
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: child.runtimeMode,
          interactionMode: child.interactionMode,
          createdAt: yield* now,
        });
        return { childThreadId: child.id };
      }),
  } satisfies Parameters<typeof ThreadsToolkit.toLayer>[0];
});

export const ThreadsToolkitHandlersLive = Layer.unwrap(
  makeHandlers.pipe(Effect.map((handlers) => ThreadsToolkit.toLayer(handlers))),
);

export const __testing = {
  hasCreator,
  validateModelSelection,
  getPendingRequests,
  classifyChildThread,
};
