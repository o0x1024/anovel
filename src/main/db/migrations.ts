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

function hasForeignKey(
  db: Database.Database,
  table: string,
  fromColumn: string,
  refTable: string
): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
    table: string
    from: string
  }[]
  return rows.some(r => r.from === fromColumn && r.table === refTable)
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

  // V2.10: works 表新增写作计划列
  if (hasTable(db, 'works') && !hasColumn(db, 'works', 'novel_length')) {
    db.exec(`ALTER TABLE works ADD COLUMN novel_length VARCHAR(10) DEFAULT 'medium'`)
  }
  if (hasTable(db, 'works') && !hasColumn(db, 'works', 'target_total_words')) {
    db.exec(`ALTER TABLE works ADD COLUMN target_total_words INTEGER`)
  }
  if (hasTable(db, 'works') && !hasColumn(db, 'works', 'target_chapters')) {
    db.exec(`ALTER TABLE works ADD COLUMN target_chapters INTEGER`)
  }
  if (hasTable(db, 'works') && !hasColumn(db, 'works', 'words_per_chapter')) {
    db.exec(`ALTER TABLE works ADD COLUMN words_per_chapter INTEGER`)
  }

  // V2.10: 将 WritingPlan 从 core_settings JSON 迁移到 works 表列
  try {
    const plans = db.prepare(
      `SELECT work_id, content FROM core_settings WHERE type = 'writing_plan'`
    ).all() as { work_id: number; content: string }[]
    for (const row of plans) {
      try {
        const plan = JSON.parse(row.content)
        if (plan && typeof plan === 'object') {
          const validLengths = ['short', 'medium', 'long']
          const novelLength = validLengths.includes(plan.novelLength) ? plan.novelLength : 'medium'
          const targetWords = typeof plan.targetTotalWords === 'number' ? Math.round(plan.targetTotalWords) : null
          const targetChapters = typeof plan.targetChapters === 'number' ? Math.round(plan.targetChapters) : null
          const wpc = typeof plan.wordsPerChapter === 'number' ? Math.round(plan.wordsPerChapter) : null
          db.prepare(
            `UPDATE works SET novel_length = ?, target_total_words = ?, target_chapters = ?, words_per_chapter = ? WHERE id = ?`
          ).run(novelLength, targetWords, targetChapters, wpc, row.work_id)
        }
      } catch { /* 跳过损坏的 JSON */ }
    }
  } catch { /* core_settings 表可能不存在 */ }

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS name_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      category VARCHAR(20) NOT NULL,
      name VARCHAR(100) NOT NULL,
      meaning TEXT,
      constraints_json TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      linked_entity TEXT,
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_name_entries_work
      ON name_entries(work_id, category, status);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS aigc_wordtable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type VARCHAR(10) NOT NULL DEFAULT 'word',
      source TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // V2.10: 修复 generated_images 外键约束（仅首次缺失外键时重建）
  if (
    hasTable(db, 'generated_images') &&
    !hasForeignKey(db, 'generated_images', 'work_id', 'works')
  ) {
    // 清理孤儿记录（work_id 为 NULL 或指向已删除作品）
    db.exec(`
      DELETE FROM generated_images
      WHERE work_id IS NULL
         OR work_id NOT IN (SELECT id FROM works)
    `)

    // 重建表以添加外键约束
    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_images_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id INTEGER NOT NULL,
        chapter_id INTEGER,
        prompt TEXT NOT NULL,
        local_path VARCHAR(200) NOT NULL,
        image_type VARCHAR(20),
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );

      INSERT INTO generated_images_new
        (id, work_id, chapter_id, prompt, local_path, image_type, create_time)
      SELECT id, work_id, chapter_id, prompt, local_path, image_type, create_time
      FROM generated_images;

      DROP TABLE generated_images;
      ALTER TABLE generated_images_new RENAME TO generated_images;
    `)
  }

  // V2.10: 修复 idea_fragments 外键策略 SET NULL → CASCADE
  if (
    hasTable(db, 'idea_fragments') &&
    !hasForeignKey(db, 'idea_fragments', 'work_id', 'works')
  ) {
    // 清理孤儿记录
    db.exec(`DELETE FROM idea_fragments WHERE work_id IS NULL`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS idea_fragments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id INTEGER,
        type VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        tags VARCHAR(200),
        is_merged INTEGER DEFAULT 0,
        merged_target VARCHAR(100),
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );

      INSERT INTO idea_fragments_new
        (id, work_id, type, content, tags, is_merged, merged_target, create_time)
      SELECT id, work_id, type, content, tags, is_merged, merged_target, create_time
      FROM idea_fragments;

      DROP TABLE idea_fragments;
      ALTER TABLE idea_fragments_new RENAME TO idea_fragments;
    `)
  }

  // V2.10: 修复 taste_profile / work_taste_relation 外键约束
  if (
    hasTable(db, 'work_taste_relation') &&
    !hasForeignKey(db, 'work_taste_relation', 'work_id', 'works')
  ) {
    // 清理孤儿记录
    db.exec(`
      DELETE FROM work_taste_relation
      WHERE work_id NOT IN (SELECT id FROM works)
         OR profile_id NOT IN (SELECT id FROM taste_profile)
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS work_taste_relation_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id INTEGER NOT NULL,
        profile_id INTEGER NOT NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(work_id, profile_id),
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
        FOREIGN KEY (profile_id) REFERENCES taste_profile(id) ON DELETE CASCADE
      );

      INSERT INTO work_taste_relation_new
        (id, work_id, profile_id, create_time)
      SELECT id, work_id, profile_id, create_time
      FROM work_taste_relation;

      DROP TABLE work_taste_relation;
      ALTER TABLE work_taste_relation_new RENAME TO work_taste_relation;
    `)
  }

  // V2.10: 性能索引（仅在目标表已存在时创建，兼容全新安装）
  const indexDefs: [string, string][] = [
    ['chapters', 'CREATE INDEX IF NOT EXISTS idx_chapters_volume_sort ON chapters(volume_id, sort)'],
    ['generation_log', 'CREATE INDEX IF NOT EXISTS idx_generation_log_work_step ON generation_log(work_id, step)'],
    ['character_snapshots', 'CREATE INDEX IF NOT EXISTS idx_character_snapshots_work_chapter ON character_snapshots(work_id, chapter_id)'],
    ['story_timeline', 'CREATE INDEX IF NOT EXISTS idx_story_timeline_work_chapter ON story_timeline(work_id, chapter_id)'],
    ['anchor_alignment_log', 'CREATE INDEX IF NOT EXISTS idx_anchor_alignment_anchor_chapter ON anchor_alignment_log(anchor_id, chapter_id)'],
  ]
  for (const [table, ddl] of indexDefs) {
    if (hasTable(db, table)) db.exec(ddl)
  }

  // V2.11: 孵化器槽位重命名 — emotion_curve → rhythm_curve, ending_image → ending_structure
  try {
    if (hasTable(db, 'incubator_storyline_draft_slots')) {
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'rhythm_curve' WHERE slot_key = 'emotion_curve'`)
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'ending_structure' WHERE slot_key = 'ending_image'`)
    }
    if (hasTable(db, 'incubator_candidates')) {
      db.exec(`UPDATE incubator_candidates SET source_step = 'rhythm_curve_gen' WHERE source_step = 'emotion_curve_gen'`)
      db.exec(`UPDATE incubator_candidates SET source_step = 'ending_structure_gen' WHERE source_step = 'ending_image_gen'`)
    }
    if (hasTable(db, 'core_settings')) {
      db.exec(`UPDATE core_settings SET type = 'incubator_rhythm_curve' WHERE type = 'incubator_emotion_curve'`)
      db.exec(`UPDATE core_settings SET type = 'incubator_ending_structure' WHERE type = 'incubator_ending_image'`)
    }
  } catch { /* 表可能不存在，跳过 */ }

  // V3.0: 核心设定 6 类重构 — character/worldview/conflict → supporting_cast/world_pressure/conflict_engine
  try {
    if (hasTable(db, 'core_settings')) {
      const migrateType = (from: string, to: string) => {
        const existing = db.prepare(
          'SELECT COUNT(*) as cnt FROM core_settings WHERE work_id IN (SELECT work_id FROM core_settings WHERE type = ?) AND type = ?'
        ).get(from, to) as { cnt: number } | undefined
        if (!existing || existing.cnt === 0) {
          // 仅当新类型不存在时才迁移，避免覆盖用户新数据
          db.exec(
            `UPDATE core_settings SET type = '${to}' WHERE type = '${from}' AND work_id NOT IN (SELECT work_id FROM core_settings WHERE type = '${to}')`
          )
        }
      }
      migrateType('character', 'supporting_cast')
      migrateType('worldview', 'world_pressure')
      migrateType('conflict', 'conflict_engine')

      // 版本表同步迁移
      if (hasTable(db, 'core_setting_versions')) {
        const migrateVersion = (from: string, to: string) => {
          db.exec(
            `UPDATE core_setting_versions SET type = '${to}' WHERE type = '${from}'`
          )
        }
        migrateVersion('character', 'supporting_cast')
        migrateVersion('worldview', 'world_pressure')
        migrateVersion('conflict', 'conflict_engine')
      }
    }
  } catch { /* 表可能不存在，跳过 */ }

  // V3.0: 锚点 scope 字段（全书级/分卷级/章节级）
  try {
    if (hasTable(db, 'anchors') && !hasColumn(db, 'anchors', 'scope')) {
      db.exec(`ALTER TABLE anchors ADD COLUMN scope VARCHAR(10) DEFAULT 'work'`)
    }
  } catch { /* 已存在 */ }

  // V3.1: works 表新增 work_type 区分小说/短故事
  try {
    if (hasTable(db, 'works') && !hasColumn(db, 'works', 'work_type')) {
      db.exec(`ALTER TABLE works ADD COLUMN work_type VARCHAR(20) DEFAULT 'novel'`)
    }
  } catch { /* 已存在 */ }

  // V3.2: chapters 表新增 outline_diagnosis 字段用于 AI 诊断报告
  try {
    if (hasTable(db, 'chapters') && !hasColumn(db, 'chapters', 'outline_diagnosis')) {
      db.exec(`ALTER TABLE chapters ADD COLUMN outline_diagnosis TEXT`)
    }
  } catch { /* 已存在 */ }

  // V3.3: works 表软删除 —— 删除作品先标记进回收站，可恢复，彻底删除才级联清除
  try {
    if (hasTable(db, 'works') && !hasColumn(db, 'works', 'deleted')) {
      db.exec(`ALTER TABLE works ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`)
      db.exec(`ALTER TABLE works ADD COLUMN deleted_time DATETIME`)
    }
  } catch { /* 已存在 */ }

  // V3.4: works 表作品元数据 —— 状态/题材/标签，用于列表筛选与分类
  try {
    if (hasTable(db, 'works') && !hasColumn(db, 'works', 'status')) {
      db.exec(`ALTER TABLE works ADD COLUMN status VARCHAR(20) DEFAULT 'ongoing'`)
      db.exec(`ALTER TABLE works ADD COLUMN genre VARCHAR(50)`)
      db.exec(`ALTER TABLE works ADD COLUMN tags TEXT`)
    }
  } catch { /* 已存在 */ }

  // V3.5: 目标循环（goal routine）—— 短故事自主驱动到可验证目标的持久化状态与轮次记忆
  try {
    if (!hasTable(db, 'goal_routine_states')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goal_routine_states (
          work_id INTEGER PRIMARY KEY,
          status VARCHAR(20) NOT NULL DEFAULT 'idle',
          turn_count INTEGER NOT NULL DEFAULT 0,
          max_turns INTEGER NOT NULL DEFAULT 30,
          current_phase VARCHAR(20),
          last_ai_percent REAL,
          last_quality_score REAL,
          goal_met INTEGER NOT NULL DEFAULT 0,
          goal_config_json TEXT,
          state_json TEXT,
          update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
        );
      `)
    }
    if (!hasTable(db, 'goal_routine_turns')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goal_routine_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_id INTEGER NOT NULL,
          turn_no INTEGER NOT NULL,
          phase VARCHAR(20),
          action VARCHAR(30),
          target_chapter_id INTEGER,
          ai_percent_before REAL,
          ai_percent_after REAL,
          score REAL,
          summary TEXT,
          create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_goal_routine_turns_work
          ON goal_routine_turns(work_id, turn_no);
      `)
    }
  } catch { /* 已存在 */ }

  // V3.6: 主线槽位重构 — hook→opening, ending_structure→ending; rhythm_curve 降级为派生分析（非槽位）
  try {
    if (hasTable(db, 'incubator_storyline_draft_slots')) {
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'opening' WHERE slot_key = 'hook'`)
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'ending' WHERE slot_key = 'ending_structure'`)
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'ending' WHERE slot_key = 'ending_image'`)
      db.exec(`UPDATE incubator_storyline_draft_slots SET slot_key = 'opening' WHERE slot_key = 'hook' AND slot_key NOT IN ('opening')`)
    }
    if (hasTable(db, 'incubator_candidates')) {
      db.exec(`UPDATE incubator_candidates SET source_step = 'ending_gen' WHERE source_step = 'ending_structure_gen'`)
      db.exec(`UPDATE incubator_candidates SET source_step = 'ending_gen' WHERE source_step = 'ending_image_gen'`)
    }
    if (hasTable(db, 'core_settings')) {
      db.exec(`UPDATE core_settings SET type = 'incubator_ending' WHERE type = 'incubator_ending_structure'`)
      db.exec(`UPDATE core_settings SET type = 'incubator_ending' WHERE type = 'incubator_ending_image'`)
    }
  } catch { /* 表可能不存在，跳过 */ }
}
