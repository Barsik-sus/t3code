import type { OrchestrationNativeAgent } from "@t3tools/contracts";

export const NATIVE_AGENT_HISTORY_LIMIT = 30;

export function pruneNativeAgents(agents: ReadonlyArray<OrchestrationNativeAgent>): {
  readonly agents: ReadonlyArray<OrchestrationNativeAgent>;
  readonly evictedAgentIds: ReadonlyArray<string>;
} {
  if (agents.length <= NATIVE_AGENT_HISTORY_LIMIT) {
    return { agents, evictedAgentIds: [] };
  }

  const running = agents.filter((agent) => agent.status === "running");
  const settled = agents
    .filter((agent) => agent.status !== "running")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const settledCapacity = Math.max(0, NATIVE_AGENT_HISTORY_LIMIT - running.length);
  const keptSettled = settled.slice(0, settledCapacity);
  const keptIds = new Set([...running, ...keptSettled].map((agent) => agent.id));

  return {
    agents: agents.filter((agent) => keptIds.has(agent.id)),
    evictedAgentIds: agents.filter((agent) => !keptIds.has(agent.id)).map((agent) => agent.id),
  };
}
