import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ChildSignalReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ChildSignalReactor extends Context.Service<
  ChildSignalReactor,
  ChildSignalReactorShape
>()("t3/orchestration/Services/ChildSignalReactor") {}
