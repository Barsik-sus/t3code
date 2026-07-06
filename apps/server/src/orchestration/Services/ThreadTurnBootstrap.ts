import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { OrchestrationDispatchCommandError } from "@t3tools/contracts";

export interface ThreadTurnBootstrapInput {
  readonly turnStartCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
  readonly createThreadCommand?: Extract<OrchestrationCommand, { type: "thread.create" }>;
  readonly prepareWorktree?: NonNullable<
    Extract<OrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"]
  >["prepareWorktree"];
  readonly runSetupScript?: boolean | undefined;
}

export interface ThreadTurnBootstrapShape {
  readonly dispatch: (
    input: ThreadTurnBootstrapInput,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ThreadTurnBootstrap extends Context.Service<
  ThreadTurnBootstrap,
  ThreadTurnBootstrapShape
>()("t3/orchestration/Services/ThreadTurnBootstrap") {}
