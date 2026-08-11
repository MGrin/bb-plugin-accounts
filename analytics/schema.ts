// The analytics tables.
//
// APPEND-ONLY. bb.storage.migrate() uses each statement's INDEX in this array
// as its migration id and records applied ids in `_bb_migrations`. Editing or
// reordering a shipped statement therefore does nothing on any machine that
// already ran it — the id is marked applied and the new text is never executed.
// Only ever append.
export const MIGRATIONS: string[] = [
  // Raw poll snapshots: one row per account per distinct poll. The composite
  // primary key IS the dedupe mechanism — the Python poller runs at 180s and
  // the bb watch tick at 120s, so roughly one tick in three re-reads a
  // polledAt that is already stored. INSERT OR IGNORE makes that free.
  `CREATE TABLE IF NOT EXISTS usage_sample (
     polled_at INTEGER NOT NULL,
     slot TEXT NOT NULL,
     five_util REAL,
     five_resets_at TEXT,
     seven_util REAL,
     seven_resets_at TEXT,
     active INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (polled_at, slot)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_sample_slot_time ON usage_sample (slot, polled_at)`,

  // Derived consumption events. Keyed on t1 rather than (t0,t1) so a
  // re-derivation of the same tail replaces rather than duplicates.
  `CREATE TABLE IF NOT EXISTS burn_interval (
     slot TEXT NOT NULL,
     window TEXT NOT NULL,
     t0 INTEGER NOT NULL,
     t1 INTEGER NOT NULL,
     delta_util REAL NOT NULL,
     is_reset INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (slot, window, t1)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_burn_interval_time ON burn_interval (window, t1)`,

  // One row per assistant message that carried a usage block. `seq` is the
  // message's ordinal within its transcript file, which makes (session_id, seq)
  // a natural idempotency key for an incremental tail that may re-read a line.
  `CREATE TABLE IF NOT EXISTS transcript_msg (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     ts INTEGER NOT NULL,
     cwd TEXT,
     project TEXT,
     model TEXT,
     is_sidechain INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_ts ON transcript_msg (ts)`,

  // The tokens -> utilization calibration, refit nightly.
  `CREATE TABLE IF NOT EXISTS model_weight (
     model TEXT PRIMARY KEY,
     points_per_1k REAL NOT NULL,
     fitted_at INTEGER NOT NULL,
     sample_count INTEGER NOT NULL DEFAULT 0,
     residual REAL
   )`,

  // Makes transcript scanning incremental: a file whose size and mtime are
  // unchanged is skipped without being opened at all.
  `CREATE TABLE IF NOT EXISTS ingest_cursor (
     path TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     byte_offset INTEGER NOT NULL
   )`,

  // ── Correction, same day: transcript_msg was keyed on (session_id, seq) ──
  //
  // A transcript writes the SAME assistant message several times — one record
  // per streaming update — each carrying a full, identical `usage` block.
  // Measured over 60 real transcripts: 1142 usage-bearing records collapse to
  // 625 distinct messages, so an ordinal key counts most tokens twice (2.07x
  // inflation overall, 3.7x in the worst file sampled). Every downstream
  // number — the calibration fit, the demand profile, the forecast — would
  // have been silently wrong by a factor that varies per file, which is worse
  // than being wrong by a constant.
  //
  // `message.id` is the real identity: present on every one of those 1142
  // records, never carrying conflicting usage for the same id, and never
  // spanning more than one requestId. Dropping and recreating is safe because
  // nothing has ever written to this table — the scanner ships after it.
  `DROP TABLE IF EXISTS transcript_msg`,
  `CREATE TABLE IF NOT EXISTS transcript_msg (
     session_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     ts INTEGER NOT NULL,
     cwd TEXT,
     project TEXT,
     model TEXT,
     is_sidechain INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, message_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_ts ON transcript_msg (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_model ON transcript_msg (model)`,

  // ── Correction: is_sidechain is dead on this machine, entrypoint is not ──
  //
  // The "who burned it — me or an agent" breakdown was going to come from
  // `isSidechain`. It cannot: across the whole archive that field is `false`
  // on all 96,985 records and `true` on exactly zero. Claude Code sets it for
  // its own Task-tool subagents, and on this machine agent work is bb threads
  // instead — each of which gets its own transcript file, not a sidechain.
  //
  // `entrypoint` carries the distinction that actually exists here:
  //   sdk-cli       33689   bb-spawned agent threads
  //   cli            8497   a human typing in a terminal
  //   sdk-ts         4431   SDK / workflow agents
  //   claude-vscode    86   the IDE extension
  //
  // Drop and rebuild rather than ALTER: existing rows are written with
  // INSERT OR IGNORE, so adding a column would leave all 24k of them NULL
  // forever. Clearing the cursors forces a full re-index, which measured 11
  // seconds for the entire 550MB archive.
  `DROP TABLE IF EXISTS transcript_msg`,
  `DELETE FROM ingest_cursor`,
  `CREATE TABLE IF NOT EXISTS transcript_msg (
     session_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     ts INTEGER NOT NULL,
     cwd TEXT,
     project TEXT,
     model TEXT,
     entrypoint TEXT,
     is_sidechain INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, message_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_ts ON transcript_msg (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_entrypoint ON transcript_msg (entrypoint)`,

  // Working directory -> GitHub repo, resolved once and cached.
  //
  // Cached rather than computed per query because resolution is not pure: it
  // shells out to git and asks bb about environments. `source` records WHICH
  // layer answered, so a label that looks wrong can be traced instead of
  // argued about. 65 of this machine's 145 directories no longer exist, so the
  // durable layers matter more than git does.
  `CREATE TABLE IF NOT EXISTS cwd_repo (
     cwd TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     source TEXT NOT NULL,
     resolved_at INTEGER NOT NULL
   )`,
];
