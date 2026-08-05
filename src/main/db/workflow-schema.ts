import type Database from 'better-sqlite3'

/**
 * 持久化工作流内核。
 *
 * 旧 goal_routine_* 表只保留为历史数据，不参与任何新运行、恢复或 UI 查询。
 * 新运行以 run/step/artifact/event 为权威来源，禁止双写。
 */
export function ensureWorkflowSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      run_seq INTEGER NOT NULL,
      workflow_type VARCHAR(30) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'idle',
      desired_state VARCHAR(24) NOT NULL DEFAULT 'running',
      turn_count INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 30,
      current_phase VARCHAR(50),
      last_ai_percent REAL,
      last_quality_score REAL,
      goal_met INTEGER NOT NULL DEFAULT 0,
      goal_config_json TEXT,
      state_json TEXT NOT NULL DEFAULT '{}',
      lease_owner VARCHAR(120),
      lease_expires_at DATETIME,
      heartbeat_at DATETIME,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_id, run_seq),
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_work
      ON workflow_runs(work_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_recovery
      ON workflow_runs(status, desired_state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS workflow_model_contracts (
      run_id INTEGER PRIMARY KEY,
      contract_version INTEGER NOT NULL,
      contract_hash VARCHAR(64) NOT NULL,
      contract_json TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS novel_authority_states (
      work_id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      state_hash VARCHAR(64) NOT NULL,
      state_json TEXT NOT NULL,
      source_run_id INTEGER,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (source_run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS novel_chapter_acceptance_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_key VARCHAR(64) NOT NULL UNIQUE,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      source_run_id INTEGER,
      last_run_id INTEGER,
      base_content_hash VARCHAR(64) NOT NULL,
      contract_hash VARCHAR(64) NOT NULL,
      protocol_version INTEGER NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      max_assessments INTEGER NOT NULL,
      max_repairs INTEGER NOT NULL,
      assessments_used INTEGER NOT NULL DEFAULT 0,
      repairs_used INTEGER NOT NULL DEFAULT 0,
      best_candidate_id INTEGER,
      terminal_code VARCHAR(80),
      terminal_reason TEXT,
      author_note TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (source_run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (last_run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_novel_acceptance_work
      ON novel_chapter_acceptance_episodes(work_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_novel_acceptance_chapter
      ON novel_chapter_acceptance_episodes(chapter_id, id DESC);

    CREATE TABLE IF NOT EXISTS novel_chapter_acceptance_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      parent_content_hash VARCHAR(64),
      source_kind VARCHAR(32) NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(episode_id, content_hash),
      FOREIGN KEY (episode_id) REFERENCES novel_chapter_acceptance_episodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_acceptance_candidates
      ON novel_chapter_acceptance_candidates(episode_id, id);

    CREATE TABLE IF NOT EXISTS novel_chapter_acceptance_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      sequence_no INTEGER NOT NULL,
      score_total REAL NOT NULL,
      hard_fail INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      blocking_failures_json TEXT NOT NULL,
      advisory_failures_json TEXT NOT NULL,
      top_issues_json TEXT NOT NULL,
      patches_json TEXT NOT NULL,
      report TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(episode_id, candidate_id),
      UNIQUE(episode_id, sequence_no),
      FOREIGN KEY (episode_id) REFERENCES novel_chapter_acceptance_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES novel_chapter_acceptance_candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_acceptance_assessments
      ON novel_chapter_acceptance_assessments(episode_id, sequence_no);

    CREATE TABLE IF NOT EXISTS novel_chapter_gate_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      gate_type VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      score REAL,
      failure_code VARCHAR(80),
      failure_reason TEXT,
      blockers_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      assessment_count INTEGER NOT NULL DEFAULT 0,
      repair_count INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(episode_id, candidate_id, gate_type),
      FOREIGN KEY (episode_id) REFERENCES novel_chapter_acceptance_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES novel_chapter_acceptance_candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_novel_chapter_gate_states
      ON novel_chapter_gate_states(episode_id, candidate_id, gate_type);

    CREATE TABLE IF NOT EXISTS novel_chapter_gate_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      gate_type VARCHAR(32) NOT NULL,
      decision_type VARCHAR(32) NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      contract_hash VARCHAR(64) NOT NULL,
      assessment_id INTEGER,
      note TEXT NOT NULL,
      actor VARCHAR(80) NOT NULL DEFAULT 'author',
      decision_revision INTEGER NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(episode_id, candidate_id, gate_type, decision_revision),
      FOREIGN KEY (episode_id) REFERENCES novel_chapter_acceptance_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES novel_chapter_acceptance_candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (assessment_id) REFERENCES novel_chapter_acceptance_assessments(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_novel_chapter_gate_decisions
      ON novel_chapter_gate_decisions(episode_id, candidate_id, gate_type, id);

    CREATE TABLE IF NOT EXISTS workflow_step_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_key VARCHAR(80) NOT NULL,
      scope_key VARCHAR(160) NOT NULL,
      input_hash VARCHAR(64) NOT NULL,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      attempt_no INTEGER NOT NULL,
      status VARCHAR(24) NOT NULL,
      error_class VARCHAR(40),
      error_code VARCHAR(80),
      error_message TEXT,
      retry_at DATETIME,
      output_artifact_id INTEGER,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, step_key, scope_key, input_hash, attempt_no),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run
      ON workflow_step_instances(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_retry
      ON workflow_step_instances(status, retry_at);

    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_instance_id INTEGER,
      artifact_kind VARCHAR(60) NOT NULL,
      scope_key VARCHAR(160) NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, artifact_kind, scope_key, content_hash, protocol_version),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (step_instance_id) REFERENCES workflow_step_instances(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      work_id INTEGER NOT NULL,
      turn_no INTEGER NOT NULL,
      phase VARCHAR(50),
      action VARCHAR(50),
      target_chapter_id INTEGER,
      ai_percent_before REAL,
      ai_percent_after REAL,
      score REAL,
      summary TEXT,
      payload_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_work
      ON workflow_events(work_id, run_id, id DESC);

    CREATE TABLE IF NOT EXISTS model_call_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id VARCHAR(120) NOT NULL UNIQUE,
      run_id INTEGER,
      step_instance_id INTEGER,
      work_id INTEGER,
      generation_step VARCHAR(80),
      model_type VARCHAR(30),
      model_name VARCHAR(160),
      status VARCHAR(24) NOT NULL,
      error_class VARCHAR(40),
      error_code VARCHAR(80),
      error_message TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      finish_reason VARCHAR(30),
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (step_instance_id) REFERENCES workflow_step_instances(id) ON DELETE SET NULL,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_attempts_run
      ON model_call_attempts(run_id, step_instance_id, id);
    CREATE INDEX IF NOT EXISTS idx_model_attempts_work
      ON model_call_attempts(work_id, id DESC);

    CREATE TABLE IF NOT EXISTS workflow_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      event_type VARCHAR(60) NOT NULL,
      payload_json TEXT NOT NULL,
      delivered_at DATETIME,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_outbox_pending
      ON workflow_outbox(delivered_at, id);
  `)

  db.transaction(() => {
    db.exec(`
      UPDATE novel_chapter_acceptance_episodes
      SET status = CASE
        WHEN status = 'accepted_by_author' THEN 'awaiting_resume'
        WHEN status = 'quality_non_convergent' THEN 'blocked'
        ELSE status
      END,
      max_repairs = MAX(max_repairs, 7);

      INSERT OR IGNORE INTO novel_chapter_gate_decisions (
        episode_id, candidate_id, gate_type, decision_type,
        content_hash, contract_hash, assessment_id, note, actor, decision_revision
      )
      SELECT episode.id, candidate.id, 'quality', 'approved_by_author',
             candidate.content_hash, episode.contract_hash, assessment.id,
             episode.author_note, 'author', 1
      FROM novel_chapter_acceptance_episodes episode
      JOIN novel_chapter_acceptance_candidates candidate
        ON candidate.id = episode.best_candidate_id
      LEFT JOIN novel_chapter_acceptance_assessments assessment
        ON assessment.episode_id = episode.id AND assessment.candidate_id = candidate.id
      WHERE TRIM(COALESCE(episode.author_note, '')) <> '';

      INSERT OR IGNORE INTO novel_chapter_gate_states (
        episode_id, candidate_id, gate_type, status, score,
        failure_code, failure_reason, blockers_json, evidence_json,
        assessment_count, repair_count
      )
      SELECT episode.id, candidate.id, 'quality',
             CASE
               WHEN decision.id IS NOT NULL THEN 'passed_author'
               WHEN assessment.passed = 1 THEN 'passed_model'
               WHEN assessment.id IS NOT NULL THEN 'failed'
               ELSE 'pending'
             END,
             assessment.score_total,
             CASE WHEN assessment.id IS NOT NULL AND assessment.passed = 0
               THEN episode.terminal_code ELSE NULL END,
             CASE WHEN assessment.id IS NOT NULL AND assessment.passed = 0
               THEN episode.terminal_reason ELSE NULL END,
             COALESCE(assessment.blocking_failures_json, '[]'),
             COALESCE(assessment.top_issues_json, '[]'),
             CASE WHEN assessment.id IS NULL THEN 0 ELSE 1 END,
             0
      FROM novel_chapter_acceptance_episodes episode
      JOIN novel_chapter_acceptance_candidates candidate
        ON candidate.id = episode.best_candidate_id
      LEFT JOIN novel_chapter_acceptance_assessments assessment
        ON assessment.episode_id = episode.id AND assessment.candidate_id = candidate.id
      LEFT JOIN novel_chapter_gate_decisions decision
        ON decision.episode_id = episode.id AND decision.candidate_id = candidate.id
       AND decision.gate_type = 'quality' AND decision.decision_type = 'approved_by_author';

      INSERT OR IGNORE INTO novel_chapter_gate_states (
        episode_id, candidate_id, gate_type, status, failure_code,
        failure_reason, blockers_json, evidence_json
      )
      SELECT episode.id, candidate.id, 'emotion',
             CASE WHEN episode.terminal_reason LIKE '%情绪%' THEN 'failed' ELSE 'pending' END,
             CASE WHEN episode.terminal_reason LIKE '%情绪%' THEN episode.terminal_code ELSE NULL END,
             CASE WHEN episode.terminal_reason LIKE '%情绪%' THEN episode.terminal_reason ELSE NULL END,
             CASE WHEN episode.terminal_reason LIKE '%情绪%'
               THEN json_array(episode.terminal_reason) ELSE '[]' END,
             '[]'
      FROM novel_chapter_acceptance_episodes episode
      JOIN novel_chapter_acceptance_candidates candidate
        ON candidate.id = episode.best_candidate_id;

      INSERT OR IGNORE INTO novel_chapter_gate_states (
        episode_id, candidate_id, gate_type, status, failure_code,
        failure_reason, blockers_json, evidence_json
      )
      SELECT episode.id, candidate.id, 'execution_contract',
             CASE WHEN episode.terminal_reason LIKE '%合同%' THEN 'failed' ELSE 'pending' END,
             CASE WHEN episode.terminal_reason LIKE '%合同%' THEN episode.terminal_code ELSE NULL END,
             CASE WHEN episode.terminal_reason LIKE '%合同%' THEN episode.terminal_reason ELSE NULL END,
             CASE WHEN episode.terminal_reason LIKE '%合同%'
               THEN json_array(episode.terminal_reason) ELSE '[]' END,
             '[]'
      FROM novel_chapter_acceptance_episodes episode
      JOIN novel_chapter_acceptance_candidates candidate
        ON candidate.id = episode.best_candidate_id;

      UPDATE novel_chapter_acceptance_episodes
      SET status = 'awaiting_resume',
          terminal_code = NULL,
          terminal_reason = NULL,
          closed_at = NULL,
          update_time = CURRENT_TIMESTAMP
      WHERE status = 'blocked'
        AND repairs_used < max_repairs
        AND terminal_code = 'REPAIR_BUDGET_EXHAUSTED'
        AND (
          terminal_reason LIKE '%情绪%'
          OR terminal_reason LIKE '%合同%'
        )
        AND EXISTS (
          SELECT 1
          FROM novel_chapter_gate_decisions decision
          WHERE decision.episode_id = novel_chapter_acceptance_episodes.id
            AND decision.gate_type = 'quality'
            AND decision.decision_type = 'approved_by_author'
        );
    `)
  })()
}
