import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  ThreadsToolkit,
  CreateChildThreadTool,
  GetChildPendingRequestsTool,
  InterruptChildThreadTool,
  ListChildThreadsTool,
  ListThreadOptionsTool,
  RespondToChildApprovalTool,
  RespondToChildUserInputTool,
  SendToChildThreadTool,
  WaitForChildThreadsTool,
} from "./tools.ts";

const tools = [
  CreateChildThreadTool,
  ListThreadOptionsTool,
  ListChildThreadsTool,
  WaitForChildThreadsTool,
  GetChildPendingRequestsTool,
  RespondToChildApprovalTool,
  RespondToChildUserInputTool,
  InterruptChildThreadTool,
  SendToChildThreadTool,
] as const;

it("describes only direct sub-thread capabilities", () => {
  const descriptions = tools.map((tool) => Tool.getDescription(tool));

  expect(descriptions).toEqual([
    "Creates a direct sub-thread for this agent session, starts its first turn, and returns the sub-thread id and title.",
    "Returns provider instances, models, model options, runtime modes, interaction modes, and this thread's default child-thread settings.",
    "Returns direct sub-threads created by this agent session with status, latest-turn state, pending-request counts, and timestamps.",
    "Long-polls direct sub-threads created by this agent session until watched sub-threads settle, become blocked, or the timeout elapses.",
    "Returns pending approval and user-input request payloads for a direct sub-thread created by this agent session.",
    "Sends an approval response to a pending approval request on a direct sub-thread created by this agent session.",
    "Sends user-input answers to a pending user-input request on a direct sub-thread created by this agent session.",
    "Requests interruption of a running turn on a direct sub-thread created by this agent session.",
    "Starts a follow-up turn on a direct sub-thread created by this agent session and returns the sub-thread id.",
  ]);
  expect(descriptions.join("\n")).not.toMatch(/\bshould\b|\bprefer\b|\bescalate\b/i);
});

it("marks read-only and mutating thread tools consistently", () => {
  for (const tool of [
    ListThreadOptionsTool,
    ListChildThreadsTool,
    WaitForChildThreadsTool,
    GetChildPendingRequestsTool,
  ]) {
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }

  for (const tool of [
    CreateChildThreadTool,
    RespondToChildApprovalTool,
    RespondToChildUserInputTool,
    InterruptChildThreadTool,
    SendToChildThreadTool,
  ]) {
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }
});

it("serializes every tool's input schema as a plain object schema", () => {
  // Strict MCP clients validate that each tools/list entry has
  // inputSchema.type === "object" and reject the whole list otherwise.
  for (const tool of Object.values(ThreadsToolkit.tools)) {
    const jsonSchema = Tool.getJsonSchema(tool) as { readonly type?: string };
    expect.soft(jsonSchema.type, tool.name).toBe("object");
  }
});
