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
];
