import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /** Settle orphaned pre-restart sessions at startup. Default true. */
  readonly recoverOrphanedSessionsOnStart?: boolean;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    // Provider processes are children of this server: none of them survived
    // the restart. Any binding still claiming a live status with a last-seen
    // timestamp from before this process started is an orphan — settle its
    // session so running turns become "interrupted" (and child-thread
    // creators get notified) instead of hanging as running forever. The
    // periodic sweep cannot do this: it deliberately skips active turns.
    const recoverOrphanedSessions = Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const bindings = yield* directory.listBindings();
      let recovered = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }
        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (!Number.isNaN(lastSeenMs) && lastSeenMs >= startedAtMs) {
          continue;
        }

        yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("provider.session.recover.stop-failed", {
              threadId: binding.threadId,
              cause,
            }),
          ),
        );

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        const session = thread?.session;
        if (!session || session.status === "stopped") {
          continue;
        }
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "thread.session.set",
            // Deterministic per attempt: a re-run of recovery for the same
            // instant dedupes via command receipts.
            commandId: CommandId.make(`session-recover:${binding.threadId}:${nowIso}`),
            threadId: binding.threadId,
            session: {
              ...session,
              threadId: binding.threadId,
              status: "stopped",
              activeTurnId: null,
              updatedAt: nowIso,
            },
            createdAt: nowIso,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.recover.dispatch-failed", {
                threadId: binding.threadId,
                cause,
              }),
            ),
          );
        recovered += 1;
      }

      if (recovered > 0) {
        yield* Effect.logInfo("provider.session.recover.complete", { recovered });
      }
    });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        if (options?.recoverOrphanedSessionsOnStart ?? true) {
          // Forked so a slow stop of a dead provider cannot stall startup.
          yield* Effect.forkScoped(
            recoverOrphanedSessions.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.recover.failed", { cause }),
              ),
            ),
          );
        }

        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
