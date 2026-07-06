import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadsHierarchy", (it) => {
  it.effect("adds hierarchy columns, backfills legacy roots, and creates lookup indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly parentThreadId: string | null;
        readonly rootThreadId: string | null;
        readonly threadDepth: number;
        readonly originJson: string | null;
        readonly notifyMode: string | null;
        readonly archivedCascadedFrom: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          parent_thread_id AS "parentThreadId",
          root_thread_id AS "rootThreadId",
          thread_depth AS "threadDepth",
          origin_json AS "originJson",
          notify_mode AS "notifyMode",
          archived_cascaded_from AS "archivedCascadedFrom"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-legacy",
          parentThreadId: null,
          rootThreadId: "thread-legacy",
          threadDepth: 0,
          originJson: null,
          notifyMode: null,
          archivedCascadedFrom: null,
        },
      ]);

      const indexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_threads_project_parent"));
      assert.ok(indexes.some((index) => index.name === "idx_projection_threads_root"));
    }),
  );
});
