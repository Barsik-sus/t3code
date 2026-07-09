import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The thread.session-set projection used to clear latest_turn_id whenever
  // a turn settled (a settle event carries activeTurnId = null), and only
  // turns with file diffs got the pointer restored by the later
  // thread.turn-diff-completed event. Restore the pointer from the newest
  // known turn for every thread that lost it.
  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turns.turn_id
      FROM projection_turns AS turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id IS NOT NULL
      ORDER BY turns.requested_at DESC, turns.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turns
        WHERE turns.thread_id = projection_threads.thread_id
          AND turns.turn_id IS NOT NULL
      )
  `;

  // has_actionable_proposed_plan derives from latest_turn_id; recompute it
  // with the restored pointers (same expression as migration 024).
  yield* sql`
    UPDATE projection_threads
    SET has_actionable_proposed_plan = COALESCE((
      SELECT CASE
        WHEN projection_threads.latest_turn_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM projection_thread_proposed_plans AS latest_turn_plan_exists
            WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
              AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
          )
          THEN CASE
            WHEN (
              SELECT latest_turn_plan.implemented_at
              FROM projection_thread_proposed_plans AS latest_turn_plan
              WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
              ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
              LIMIT 1
            ) IS NULL
              THEN 1
              ELSE 0
            END
        WHEN EXISTS (
          SELECT 1
          FROM projection_thread_proposed_plans AS any_plan
          WHERE any_plan.thread_id = projection_threads.thread_id
        )
          THEN CASE
            WHEN (
              SELECT latest_plan.implemented_at
              FROM projection_thread_proposed_plans AS latest_plan
              WHERE latest_plan.thread_id = projection_threads.thread_id
              ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
              LIMIT 1
            ) IS NULL
              THEN 1
              ELSE 0
            END
        ELSE 0
      END
    ), 0)
  `;
});
