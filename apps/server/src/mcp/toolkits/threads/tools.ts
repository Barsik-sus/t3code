import {
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const ThreadToolError = Schema.Struct({
  message: Schema.String,
});

const WorkspacePlacement = Schema.Union([
  Schema.Struct({ placement: Schema.Literal("parent") }),
  Schema.Struct({ placement: Schema.Literal("project-root") }),
  Schema.Struct({
    placement: Schema.Literal("new-worktree"),
    baseBranch: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);

const CreateChildThreadInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  initialPrompt: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  notify: Schema.optional(Schema.Literals(["none", "steer"])),
  workspace: Schema.optional(WorkspacePlacement),
});

const CreateChildThreadResult = Schema.Struct({
  childThreadId: Schema.String,
  title: Schema.String,
});

// An empty Schema.Struct({}) serializes to JSON Schema without a top-level
// "type": "object", which strict MCP clients reject for the entire tools/list
// response. A never-valued record keeps the no-parameter contract while
// serializing as a plain object schema.
const EmptyToolInput = Schema.Record(Schema.String, Schema.Never);

const ListThreadOptionsInput = EmptyToolInput;

const ListThreadOptionsResult = Schema.Unknown;

const ListChildThreadsInput = EmptyToolInput;

const ListChildThreadsResult = Schema.Struct({
  children: Schema.Array(
    Schema.Struct({
      childThreadId: Schema.String,
      title: Schema.String,
      sessionStatus: Schema.NullOr(Schema.String),
      latestTurnId: Schema.NullOr(Schema.String),
      latestTurnState: Schema.NullOr(Schema.String),
      pendingApprovalCount: Schema.Number,
      pendingQuestionCount: Schema.Number,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
});

const WaitForChildThreadsInput = Schema.Struct({
  childThreadIds: Schema.optional(Schema.Array(Schema.String)),
  mode: Schema.optional(Schema.Literals(["any", "all"])),
  turnId: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
});

const WaitForChildThreadsResult = Schema.Struct({
  settled: Schema.Array(Schema.Unknown),
  blocked: Schema.Array(Schema.Unknown),
  pending: Schema.Array(Schema.String),
});

const ChildThreadIdInput = Schema.Struct({
  childThreadId: Schema.String,
});

const GetChildPendingRequestsResult = Schema.Struct({
  approvals: Schema.Array(Schema.Unknown),
  questions: Schema.Array(Schema.Unknown),
});

const RespondToChildApprovalInput = Schema.Struct({
  childThreadId: Schema.String,
  requestId: Schema.String,
  decision: ProviderApprovalDecision,
});

const RespondToChildUserInputInput = Schema.Struct({
  childThreadId: Schema.String,
  requestId: Schema.String,
  answers: ProviderUserInputAnswers,
});

const RespondResult = Schema.Struct({
  outcome: Schema.Literals(["applied", "already-resolved"]),
});

const InterruptChildThreadInput = Schema.Struct({
  childThreadId: Schema.String,
  turnId: Schema.optional(Schema.String),
});

const InterruptChildThreadResult = Schema.Struct({
  outcome: Schema.Literal("requested"),
});

const SendToChildThreadInput = Schema.Struct({
  childThreadId: Schema.String,
  message: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
});

const SendToChildThreadResult = Schema.Struct({
  childThreadId: Schema.String,
});

const threadTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false).annotate(Tool.Destructive, false) as T;

const readonlyThreadTool = <T extends Tool.Any>(tool: T): T =>
  threadTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const mutatingThreadTool = <T extends Tool.Any>(tool: T): T =>
  threadTool(tool).annotate(Tool.Destructive, true) as T;

export const CreateChildThreadTool = mutatingThreadTool(
  Tool.make("create_child_thread", {
    description:
      "Creates a direct sub-thread for this agent session, starts its first turn, and returns the sub-thread id and title.",
    parameters: CreateChildThreadInput,
    success: CreateChildThreadResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Create sub-thread"),
);

export const ListThreadOptionsTool = readonlyThreadTool(
  Tool.make("list_thread_options", {
    description:
      "Returns provider instances, models, model options, runtime modes, interaction modes, and this thread's default child-thread settings.",
    parameters: ListThreadOptionsInput,
    success: ListThreadOptionsResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "List sub-thread options"),
);

export const ListChildThreadsTool = readonlyThreadTool(
  Tool.make("list_child_threads", {
    description:
      "Returns direct sub-threads created by this agent session with status, latest-turn state, pending-request counts, and timestamps.",
    parameters: ListChildThreadsInput,
    success: ListChildThreadsResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "List sub-threads"),
);

export const WaitForChildThreadsTool = readonlyThreadTool(
  Tool.make("wait_for_child_threads", {
    description:
      "Long-polls direct sub-threads created by this agent session until watched sub-threads settle, become blocked, or the timeout elapses.",
    parameters: WaitForChildThreadsInput,
    success: WaitForChildThreadsResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Wait for sub-threads"),
);

export const GetChildPendingRequestsTool = readonlyThreadTool(
  Tool.make("get_child_pending_requests", {
    description:
      "Returns pending approval and user-input request payloads for a direct sub-thread created by this agent session.",
    parameters: ChildThreadIdInput,
    success: GetChildPendingRequestsResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Get sub-thread pending requests"),
);

export const RespondToChildApprovalTool = mutatingThreadTool(
  Tool.make("respond_to_child_approval", {
    description:
      "Sends an approval response to a pending approval request on a direct sub-thread created by this agent session.",
    parameters: RespondToChildApprovalInput,
    success: RespondResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Respond to sub-thread approval"),
);

export const RespondToChildUserInputTool = mutatingThreadTool(
  Tool.make("respond_to_child_user_input", {
    description:
      "Sends user-input answers to a pending user-input request on a direct sub-thread created by this agent session.",
    parameters: RespondToChildUserInputInput,
    success: RespondResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Respond to sub-thread user input"),
);

export const InterruptChildThreadTool = mutatingThreadTool(
  Tool.make("interrupt_child_thread", {
    description:
      "Requests interruption of a running turn on a direct sub-thread created by this agent session.",
    parameters: InterruptChildThreadInput,
    success: InterruptChildThreadResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Interrupt sub-thread"),
);

export const SendToChildThreadTool = mutatingThreadTool(
  Tool.make("send_to_child_thread", {
    description:
      "Starts a follow-up turn on a direct sub-thread created by this agent session and returns the sub-thread id.",
    parameters: SendToChildThreadInput,
    success: SendToChildThreadResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Send to sub-thread"),
);

export const ThreadsToolkit = Toolkit.make(
  CreateChildThreadTool,
  ListThreadOptionsTool,
  ListChildThreadsTool,
  WaitForChildThreadsTool,
  GetChildPendingRequestsTool,
  RespondToChildApprovalTool,
  RespondToChildUserInputTool,
  InterruptChildThreadTool,
  SendToChildThreadTool,
);
