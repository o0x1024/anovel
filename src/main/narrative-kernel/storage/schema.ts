import type Database from 'better-sqlite3'

export const NARRATIVE_EVENT_STORE_SCHEMA_VERSION = 7

export function ensureNarrativeEventStoreSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_kernel_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const version = db.prepare(
    "SELECT value FROM narrative_kernel_meta WHERE key = 'schema_version'"
  ).get() as { value: string } | undefined
  const storedVersion = version ? Number(version.value) : 0
  if (version && (storedVersion > NARRATIVE_EVENT_STORE_SCHEMA_VERSION || storedVersion < 5)) {
    throw new Error(
      `NARRATIVE_EVENT_STORE_SCHEMA_VERSION_MISMATCH:${version?.value}`
    )
  }

  if (storedVersion === 6) {
    const columns = db.prepare('PRAGMA table_info(narrative_auto_novel_runs)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'recovered_from_run_id')) {
      db.exec('ALTER TABLE narrative_auto_novel_runs ADD COLUMN recovered_from_run_id TEXT')
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_novels (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS narrative_streams (
      novel_id INTEGER PRIMARY KEY,
      head_revision INTEGER NOT NULL DEFAULT 0,
      state_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS narrative_chapter_intents (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      chapter_ordinal INTEGER NOT NULL,
      base_state_revision INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL,
      intent_json TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (novel_id, chapter_ordinal, contract_hash),
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS narrative_chapter_candidates (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      parent_candidate_id TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('model', 'author', 'revision')),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      word_count INTEGER NOT NULL CHECK (word_count > 0),
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (intent_id, content_hash),
      FOREIGN KEY (intent_id) REFERENCES narrative_chapter_intents(id),
      FOREIGN KEY (parent_candidate_id) REFERENCES narrative_chapter_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_patch_candidates (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      base_state_revision INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL,
      patch_json TEXT NOT NULL,
      patch_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candidate_id, patch_hash),
      FOREIGN KEY (intent_id) REFERENCES narrative_chapter_intents(id),
      FOREIGN KEY (candidate_id) REFERENCES narrative_chapter_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_editorial_gate_results (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      gate_type TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
      score REAL,
      report TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candidate_id, gate_type, policy_version),
      FOREIGN KEY (candidate_id) REFERENCES narrative_chapter_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_editorial_evidence_spans (
      id TEXT PRIMARY KEY,
      gate_result_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
      quote_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (gate_result_id, start_offset, end_offset, quote_hash),
      FOREIGN KEY (gate_result_id) REFERENCES narrative_editorial_gate_results(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES narrative_chapter_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_chapter_versions (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      chapter_ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      committed_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (novel_id, chapter_ordinal, committed_revision),
      UNIQUE (novel_id, content_hash, committed_revision),
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS narrative_commits (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      chapter_version_id TEXT NOT NULL UNIQUE,
      chapter_ordinal INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      commit_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (novel_id, revision),
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_version_id) REFERENCES narrative_chapter_versions(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_evidence_spans (
      id TEXT PRIMARY KEY,
      chapter_version_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
      quote_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapter_version_id) REFERENCES narrative_chapter_versions(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_events (
      id TEXT PRIMARY KEY,
      commit_id TEXT NOT NULL,
      novel_id INTEGER NOT NULL,
      stream_revision INTEGER NOT NULL,
      sequence_in_commit INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      evidence_span_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (novel_id, stream_revision, sequence_in_commit),
      UNIQUE (commit_id, sequence_in_commit),
      FOREIGN KEY (commit_id) REFERENCES narrative_commits(id) ON DELETE CASCADE,
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_span_id) REFERENCES narrative_evidence_spans(id)
    );

    CREATE INDEX IF NOT EXISTS idx_narrative_events_replay
      ON narrative_events(novel_id, stream_revision, sequence_in_commit);

    CREATE TABLE IF NOT EXISTS narrative_state_revisions (
      novel_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      parent_revision INTEGER NOT NULL,
      commit_id TEXT NOT NULL UNIQUE,
      state_hash TEXT NOT NULL,
      reducer_version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (novel_id, revision),
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE,
      FOREIGN KEY (commit_id) REFERENCES narrative_commits(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_pipeline_commits (
      commit_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL UNIQUE,
      patch_id TEXT NOT NULL UNIQUE,
      intent_hash TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      patch_hash TEXT NOT NULL,
      editorial_policy_version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (commit_id) REFERENCES narrative_commits(id),
      FOREIGN KEY (intent_id) REFERENCES narrative_chapter_intents(id),
      FOREIGN KEY (candidate_id) REFERENCES narrative_chapter_candidates(id),
      FOREIGN KEY (patch_id) REFERENCES narrative_patch_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_workflow_runs (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      intent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('running', 'blocked', 'cancelled', 'completed')
      ),
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'cancelled')),
      current_phase TEXT NOT NULL,
      candidate_id TEXT,
      patch_id TEXT,
      repair_count INTEGER NOT NULL DEFAULT 0,
      max_repairs INTEGER NOT NULL,
      phase_attempt INTEGER NOT NULL DEFAULT 0,
      max_step_attempts INTEGER NOT NULL,
      editorial_gate_index INTEGER NOT NULL DEFAULT 0,
      editorial_policy_version INTEGER NOT NULL,
      model_contract_json TEXT NOT NULL,
      model_contract_hash TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE,
      FOREIGN KEY (intent_id) REFERENCES narrative_chapter_intents(id),
      FOREIGN KEY (candidate_id) REFERENCES narrative_chapter_candidates(id),
      FOREIGN KEY (patch_id) REFERENCES narrative_patch_candidates(id)
    );

    CREATE TABLE IF NOT EXISTS narrative_workflow_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      output_ref TEXT,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      UNIQUE (run_id, step_key, input_hash, attempt_no),
      FOREIGN KEY (run_id) REFERENCES narrative_workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_narrative_workflow_steps_run
      ON narrative_workflow_steps(run_id, started_at, id);

    CREATE TABLE IF NOT EXISTS narrative_model_calls (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      task TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      finish_reason TEXT,
      content TEXT,
      content_hash TEXT,
      structured_output_json TEXT,
      structured_output_hash TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_length INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES narrative_workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES narrative_workflow_steps(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_narrative_model_calls_run
      ON narrative_model_calls(run_id, created_at, id);

    CREATE TABLE IF NOT EXISTS narrative_auto_novel_runs (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'blocked', 'cancelled', 'completed')),
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'cancelled')),
      current_phase TEXT NOT NULL CHECK (current_phase IN ('plan_novel', 'generate_chapter', 'completed')),
      target_chapters INTEGER NOT NULL CHECK (target_chapters > 0),
      word_min INTEGER NOT NULL CHECK (word_min > 0),
      word_max INTEGER NOT NULL CHECK (word_max >= word_min),
      premise TEXT NOT NULL,
      recovered_from_run_id TEXT,
      blueprint_json TEXT,
      blueprint_hash TEXT,
      active_chapter_run_id TEXT,
      model_contract_json TEXT NOT NULL,
      model_contract_hash TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (novel_id) REFERENCES narrative_novels(id) ON DELETE CASCADE,
      FOREIGN KEY (active_chapter_run_id) REFERENCES narrative_workflow_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_narrative_auto_novel_runs_novel
      ON narrative_auto_novel_runs(novel_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS narrative_auto_novel_model_calls (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      task TEXT NOT NULL CHECK (task IN ('novel_blueprint', 'chapter_intent')),
      request_json TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      response_json TEXT,
      response_hash TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES narrative_auto_novel_runs(id) ON DELETE CASCADE
    );
  `)

  if (!version) {
    db.prepare(
      "INSERT INTO narrative_kernel_meta (key, value) VALUES ('schema_version', ?)"
    ).run(String(NARRATIVE_EVENT_STORE_SCHEMA_VERSION))
  } else if (storedVersion !== NARRATIVE_EVENT_STORE_SCHEMA_VERSION) {
    db.prepare(
      "UPDATE narrative_kernel_meta SET value = ? WHERE key = 'schema_version'"
    ).run(String(NARRATIVE_EVENT_STORE_SCHEMA_VERSION))
  }
}
