import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN agent_id TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
