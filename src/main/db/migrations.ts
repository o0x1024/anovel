import type Database from 'better-sqlite3'

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some(r => r.name === column)
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(table) as { name: string } | undefined
  return !!row
}

function isColumnNotNull(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]
  const col = rows.find(r => r.name === column)
  return col?.notnull === 1
}

/**
 * 幂等增量迁移：每次获取 DB 连接时执行，兼容热更新后未重跑 initSchema 的情况
 */
export function ensureIncrementalMigrations(db: Database.Database): void {
  if (hasTable(db, 'core_settings') && !hasColumn(db, 'core_settings', 'update_time')) {
    db.exec(`ALTER TABLE core_settings ADD COLUMN update_time DATETIME`)
    db.exec(
      `UPDATE core_settings SET update_time = COALESCE(create_time, CURRENT_TIMESTAMP) WHERE update_time IS NULL`
    )
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS core_setting_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      type VARCHAR(30) NOT NULL,
      content TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(80) NOT NULL,
      description TEXT,
      icon VARCHAR(40) NOT NULL DEFAULT 'robot',
      system_prompt TEXT NOT NULL,
      analysis_rules_json TEXT,
      capabilities_json TEXT,
      is_builtin INTEGER DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assistant_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title VARCHAR(200) NOT NULL,
      file_name VARCHAR(200),
      content_text TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      fingerprint_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER,
      title VARCHAR(200) NOT NULL DEFAULT '新对话',
      document_ids_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES assistant_roles(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      message_type VARCHAR(20) NOT NULL DEFAULT 'text',
      metadata_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
    );
  `)

  if (hasTable(db, 'assistant_conversations') && !hasColumn(db, 'assistant_conversations', 'model_type')) {
    db.exec(`ALTER TABLE assistant_conversations ADD COLUMN model_type VARCHAR(20)`)
  }

  if (hasTable(db, 'assistant_conversations') && !hasColumn(db, 'assistant_conversations', 'model_name')) {
    db.exec(`ALTER TABLE assistant_conversations ADD COLUMN model_name VARCHAR(100)`)
  }

  if (
    hasTable(db, 'assistant_conversations') &&
    isColumnNotNull(db, 'assistant_conversations', 'role_id')
  ) {
    db.exec(`
      CREATE TABLE assistant_conversations_role_nullable (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_id INTEGER,
        title VARCHAR(200) NOT NULL DEFAULT '新对话',
        document_ids_json TEXT,
        model_type VARCHAR(20),
        model_name VARCHAR(100),
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (role_id) REFERENCES assistant_roles(id) ON DELETE RESTRICT
      );

      INSERT INTO assistant_conversations_role_nullable (
        id, role_id, title, document_ids_json, model_type, model_name, create_time, update_time
      )
      SELECT
        id, role_id, title, document_ids_json, model_type, model_name, create_time, update_time
      FROM assistant_conversations;

      DROP TABLE assistant_conversations;
      ALTER TABLE assistant_conversations_role_nullable RENAME TO assistant_conversations;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_preferences (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_text TEXT NOT NULL,
      result_text TEXT,
      style_id INTEGER,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      error_message TEXT,
      source_file VARCHAR(200),
      char_count INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  if (hasTable(db, 'model_configs') && !hasColumn(db, 'model_configs', 'available_models_json')) {
    db.exec(`ALTER TABLE model_configs ADD COLUMN available_models_json TEXT`)
  }

  if (hasTable(db, 'model_configs') && !hasColumn(db, 'model_configs', 'display_name')) {
    db.exec(`ALTER TABLE model_configs ADD COLUMN display_name VARCHAR(100)`)
  }

  if (hasTable(db, 'model_configs') && !hasColumn(db, 'model_configs', 'provider_protocol')) {
    db.exec(`ALTER TABLE model_configs ADD COLUMN provider_protocol VARCHAR(20)`)
  }

  if (hasTable(db, 'model_configs') && !hasColumn(db, 'model_configs', 'provider_options_json')) {
    db.exec(`ALTER TABLE model_configs ADD COLUMN provider_options_json TEXT`)
  }

  if (hasTable(db, 'lab_task') && !hasColumn(db, 'lab_task', 'style_id')) {
    db.exec(`ALTER TABLE lab_task ADD COLUMN style_id INTEGER`)
  }

  if (hasTable(db, 'lab_task') && !hasColumn(db, 'lab_task', 'anti_ai_rules_json')) {
    db.exec(`ALTER TABLE lab_task ADD COLUMN anti_ai_rules_json TEXT`)
  }

  if (hasTable(db, 'lab_task') && !hasColumn(db, 'lab_task', 'system_prompt')) {
    db.exec(`ALTER TABLE lab_task ADD COLUMN system_prompt TEXT`)
  }

  if (hasTable(db, 'writing_styles') && !hasColumn(db, 'writing_styles', 'step_rules_json')) {
    db.exec(`ALTER TABLE writing_styles ADD COLUMN step_rules_json TEXT`)
  }

  if (hasTable(db, 'writing_styles') && !hasColumn(db, 'writing_styles', 'reference_text')) {
    db.exec(`ALTER TABLE writing_styles ADD COLUMN reference_text TEXT`)
  }

  if (hasTable(db, 'anchors') && !hasColumn(db, 'anchors', 'target_chapter_id')) {
    db.exec(`ALTER TABLE anchors ADD COLUMN target_chapter_id INTEGER`)
  }
  if (hasTable(db, 'anchors') && !hasColumn(db, 'anchors', 'target_volume_id')) {
    db.exec(`ALTER TABLE anchors ADD COLUMN target_volume_id INTEGER`)
  }

  if (hasTable(db, 'works') && !hasColumn(db, 'works', 'step_temperature_json')) {
    db.exec(`ALTER TABLE works ADD COLUMN step_temperature_json TEXT`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key VARCHAR(100) NOT NULL UNIQUE,
      category VARCHAR(30) NOT NULL DEFAULT 'internal',
      label VARCHAR(100) NOT NULL DEFAULT '',
      builtin_version INTEGER NOT NULL DEFAULT 1,
      builtin_text TEXT NOT NULL DEFAULT '',
      user_text TEXT,
      description TEXT,
      variables_json TEXT,
      risk_level VARCHAR(10) NOT NULL DEFAULT 'safe',
      update_time DATETIME
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS incubator_seeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL UNIQUE,
      content TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS incubator_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      source_step VARCHAR(30) NOT NULL,
      title VARCHAR(200) NOT NULL,
      summary TEXT NOT NULL,
      dimension VARCHAR(100),
      highlights TEXT,
      audience TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      raw_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_incubator_candidates_work
      ON incubator_candidates(work_id, status, create_time);

    CREATE TABLE IF NOT EXISTS incubator_candidate_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      attraction_score INTEGER NOT NULL DEFAULT 0,
      serializability_score INTEGER NOT NULL DEFAULT 0,
      differentiation_score INTEGER NOT NULL DEFAULT 0,
      conflict_closure_score INTEGER NOT NULL DEFAULT 0,
      executability_score INTEGER NOT NULL DEFAULT 0,
      system_total INTEGER NOT NULL DEFAULT 0,
      user_adjustment INTEGER NOT NULL DEFAULT 0,
      final_total INTEGER NOT NULL DEFAULT 0,
      rationale TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (candidate_id) REFERENCES incubator_candidates(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_incubator_scores_candidate
      ON incubator_candidate_scores(candidate_id, create_time);

    CREATE TABLE IF NOT EXISTS incubator_storyline_draft_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      slot_key VARCHAR(30) NOT NULL,
      content TEXT NOT NULL,
      source_candidate_id INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      version_tag VARCHAR(30) NOT NULL DEFAULT 'draft-current',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (source_candidate_id) REFERENCES incubator_candidates(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_incubator_slots_work
      ON incubator_storyline_draft_slots(work_id, slot_key, status);

    CREATE TABLE IF NOT EXISTS incubator_storyline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      version_no INTEGER NOT NULL,
      label VARCHAR(100) NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL,
      base_version_id INTEGER,
      is_frozen INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (base_version_id) REFERENCES incubator_storyline_versions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_incubator_versions_work
      ON incubator_storyline_versions(work_id, version_no);

    CREATE TABLE IF NOT EXISTS incubator_workflow_states (
      work_id INTEGER PRIMARY KEY,
      state VARCHAR(30) NOT NULL DEFAULT 'SeedReady',
      last_gate_report_json TEXT,
      last_adopt_json TEXT,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
  `)

  if (hasTable(db, 'incubator_workflow_states') && !hasColumn(db, 'incubator_workflow_states', 'branch_base_version_id')) {
    db.exec(`ALTER TABLE incubator_workflow_states ADD COLUMN branch_base_version_id INTEGER`)
  }
}
