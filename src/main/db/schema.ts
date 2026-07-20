import { getDatabase } from './connection'
import { ensureIncrementalMigrations } from './migrations'

/**
 * 初始化数据库表结构（V1.0 核心表）
 * 所有表使用 IF NOT EXISTS，支持增量迁移
 */
export function initSchema(): void {
  const db = getDatabase()

  db.exec(`
    -- ============================================
    -- 作品表
    -- ============================================
    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title VARCHAR(100) NOT NULL,
      description TEXT,
      cover_image VARCHAR(200),
      novel_length VARCHAR(10) DEFAULT 'medium',
      target_total_words INTEGER,
      target_chapters INTEGER,
      words_per_chapter INTEGER,
      step_temperature_json TEXT,
      work_type VARCHAR(20) DEFAULT 'novel',
      status VARCHAR(20) DEFAULT 'ongoing',
      genre VARCHAR(50),
      tags TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_time DATETIME,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- 核心设定表（人设/世界观/核心冲突）
    -- ============================================
    CREATE TABLE IF NOT EXISTS core_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      type VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      structured_content TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 分卷大纲表
    -- ============================================
    CREATE TABLE IF NOT EXISTS volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      sort INTEGER NOT NULL,
      planned_start_chapter INTEGER,
      planned_end_chapter INTEGER,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 章节表
    -- ============================================
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      volume_id INTEGER NOT NULL,
      title VARCHAR(100) NOT NULL,
      outline TEXT,
      content TEXT,
      word_count INTEGER DEFAULT 0,
      sort INTEGER NOT NULL,
      status VARCHAR(20) DEFAULT 'draft',
      outline_diagnosis TEXT,
      emotion_contract_json TEXT,
      emotion_assessment_json TEXT,
      quality_assessment_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 模型配置表
    -- ============================================
    CREATE TABLE IF NOT EXISTS model_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_type VARCHAR(20) NOT NULL UNIQUE,
      api_key VARCHAR(200),
      api_base VARCHAR(200),
      is_enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 1,
      max_context_tokens INTEGER DEFAULT 256000
    );

    -- ============================================
    -- 文风表
    -- ============================================
    CREATE TABLE IF NOT EXISTS writing_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(50) NOT NULL UNIQUE,
      description TEXT,
      sample_text TEXT,
      reference_text TEXT,
      prompt_template TEXT NOT NULL,
      fingerprint_json TEXT,
      is_builtin INTEGER DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- 作品-文风关联表
    -- ============================================
    CREATE TABLE IF NOT EXISTS work_style_relation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      style_id INTEGER NOT NULL,
      evolution_curve_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_id, style_id),
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (style_id) REFERENCES writing_styles(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 锚点表（贯穿全流程的创作宪法）
    -- ============================================
    CREATE TABLE IF NOT EXISTS anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      type VARCHAR(20) NOT NULL,
      title VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      scope VARCHAR(10) DEFAULT 'work',
      is_active INTEGER DEFAULT 1,
      created_step VARCHAR(20),
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- AI 收藏表（诊断说明、生成建议等）
    -- ============================================
    CREATE TABLE IF NOT EXISTS ai_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      source_step VARCHAR(30) NOT NULL,
      source_label VARCHAR(50) NOT NULL,
      title VARCHAR(200),
      content TEXT NOT NULL,
      source_input TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 灵感碎片表
    -- ============================================
    CREATE TABLE IF NOT EXISTS idea_fragments (
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

    -- ============================================
    -- 生成记录表（创作链路追踪）
    -- ============================================
    CREATE TABLE IF NOT EXISTS generation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      step VARCHAR(30) NOT NULL,
      model_type VARCHAR(20) NOT NULL,
      style_id INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      ai_self_score REAL,
      author_action VARCHAR(20),
      reject_reason VARCHAR(50),
      duration_ms INTEGER,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 章节版本表
    -- ============================================
    CREATE TABLE IF NOT EXISTS chapter_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      outline TEXT,
      content TEXT,
      word_count INTEGER DEFAULT 0,
      model_type VARCHAR(20),
      style_id INTEGER,
      generation_round INTEGER DEFAULT 1,
      snapshot_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 短故事 Harness：候选沙箱 / 问题账本 / 发布快照（V4.2）
    -- ============================================
    CREATE TABLE IF NOT EXISTS story_generation_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      base_content_hash VARCHAR(80),
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'generated',
      source_step VARCHAR(50) NOT NULL DEFAULT 'body_generation',
      attempt_no INTEGER NOT NULL DEFAULT 1,
      checks_json TEXT,
      reject_reason TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_candidates_work_chapter
      ON story_generation_candidates(work_id, chapter_id, id);
    CREATE INDEX IF NOT EXISTS idx_story_candidates_status
      ON story_generation_candidates(work_id, status, update_time);

    CREATE TABLE IF NOT EXISTS story_issue_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      issue_key VARCHAR(300) NOT NULL,
      code VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      scope VARCHAR(20) NOT NULL,
      chapter_ids_json TEXT,
      evidence_json TEXT,
      invariants_json TEXT,
      expected_result TEXT,
      message TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      clean_confirmations INTEGER NOT NULL DEFAULT 0,
      last_checked_hash VARCHAR(80),
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      first_seen_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_time DATETIME,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      UNIQUE(work_id, issue_key)
    );

    CREATE INDEX IF NOT EXISTS idx_story_issue_work_status
      ON story_issue_ledger(work_id, status, severity);

    CREATE TABLE IF NOT EXISTS story_release_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      label VARCHAR(100) NOT NULL,
      content_hash VARCHAR(80) NOT NULL,
      snapshot_json TEXT NOT NULL,
      is_frozen INTEGER NOT NULL DEFAULT 1,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_release_work
      ON story_release_snapshots(work_id, create_time);

    CREATE TABLE IF NOT EXISTS story_lead_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      source_step VARCHAR(50) NOT NULL DEFAULT 'story_lead_repair',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_lead_versions_work
      ON story_lead_versions(work_id, id);

    -- ============================================
    -- 伏笔追踪表（V1.5）
    -- ============================================
    CREATE TABLE IF NOT EXISTS foreshadowing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      plant_chapter_id INTEGER,
      plant_location TEXT,
      payoff_chapter_id INTEGER,
      payoff_location TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 角色状态快照表（V1.5）
    -- ============================================
    CREATE TABLE IF NOT EXISTS character_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      character_name VARCHAR(50) NOT NULL,
      chapter_id INTEGER NOT NULL,
      location TEXT,
      mental_state TEXT,
      known_info TEXT,
      relationship_changes TEXT,
      ability_changes TEXT,
      numeric_stats TEXT,
      snapshot_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS emotional_state_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      character_name VARCHAR(100) NOT NULL,
      felt_state TEXT NOT NULL,
      displayed_state TEXT NOT NULL,
      unresolved_emotion TEXT NOT NULL,
      protective_strategy TEXT NOT NULL,
      behavioral_aftereffect TEXT NOT NULL,
      beliefs_json TEXT,
      relationships_json TEXT,
      source_event TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emotional_state_work_character
      ON emotional_state_ledger(work_id, character_name, chapter_id);

    -- ============================================
    -- 通用故事状态账本与章节模式指纹（V4.1）
    -- ============================================
    CREATE TABLE IF NOT EXISTS story_state_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      entity VARCHAR(120) NOT NULL,
      state_key VARCHAR(120) NOT NULL,
      value_type VARCHAR(20) NOT NULL,
      value_json TEXT NOT NULL,
      transition VARCHAR(20) NOT NULL,
      irreversible INTEGER NOT NULL DEFAULT 0,
      evidence TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_state_facts_work_chapter
      ON story_state_facts(work_id, chapter_id);
    CREATE INDEX IF NOT EXISTS idx_story_state_facts_entity_key
      ON story_state_facts(work_id, entity, state_key);

    CREATE TABLE IF NOT EXISTS chapter_pattern_fingerprints (
      chapter_id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      conflict_type TEXT NOT NULL,
      protagonist_method TEXT NOT NULL,
      antagonist_tactic TEXT NOT NULL,
      antagonist_outcome TEXT NOT NULL,
      opponent_adjustment TEXT NOT NULL,
      location_type TEXT NOT NULL,
      hook_type TEXT NOT NULL,
      cost_type TEXT NOT NULL,
      relationship_delta TEXT NOT NULL,
      volume_objective_delta TEXT NOT NULL,
      payoff_type VARCHAR(20) NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chapter_pattern_work
      ON chapter_pattern_fingerprints(work_id, chapter_id);

    -- ============================================
    -- 资源约束账本（体力/法力/积分/等级/冷却等跨章节可变状态）
    -- ============================================
    CREATE TABLE IF NOT EXISTS resource_constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      owner VARCHAR(100),
      resource VARCHAR(100) NOT NULL,
      unit VARCHAR(20),
      initial_value REAL,
      min_value REAL,
      max_value REAL,
      hard_rules_json TEXT,
      milestones_json TEXT,
      spend_rules_json TEXT,
      recover_rules_json TEXT,
      source_types TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chapter_resource_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      owner VARCHAR(100),
      resource VARCHAR(100) NOT NULL,
      unit VARCHAR(20),
      start_min REAL,
      start_max REAL,
      end_min REAL,
      end_max REAL,
      allowed_events TEXT,
      forbidden_events TEXT,
      reason TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 故事时间线表（V1.5）
    -- ============================================
    CREATE TABLE IF NOT EXISTS story_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      event_name VARCHAR(200) NOT NULL,
      event_description TEXT,
      absolute_time VARCHAR(100),
      relative_time VARCHAR(100),
      chapter_id INTEGER,
      sort_order INTEGER,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    -- ============================================
    -- 锚点对齐检测记录表（V1.5）
    -- ============================================
    CREATE TABLE IF NOT EXISTS anchor_alignment_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_id INTEGER NOT NULL,
      chapter_id INTEGER,
      step VARCHAR(20) NOT NULL,
      aligned INTEGER NOT NULL,
      detail TEXT,
      check_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anchor_id) REFERENCES anchors(id) ON DELETE CASCADE
    );
  `)

  // V1.1 增量迁移：为 model_configs 添加 model_name 字段
  try {
    db.exec(`ALTER TABLE model_configs ADD COLUMN model_name VARCHAR(100)`)
  } catch {
    // 字段已存在，忽略
  }

  // V2.7 Token 预算：模型最大上下文
  try {
    db.exec(`ALTER TABLE model_configs ADD COLUMN max_context_tokens INTEGER DEFAULT 256000`)
  } catch { /* 已存在 */ }

  // V2.8 文风分步规则
  try {
    db.exec(`ALTER TABLE writing_styles ADD COLUMN step_rules_json TEXT`)
  } catch { /* 已存在 */ }

  // V1.5 增量迁移
  try {
    db.exec(`ALTER TABLE foreshadowing ADD COLUMN depth VARCHAR(10) DEFAULT 'normal'`)
  } catch { /* 已存在 */ }
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN emotion_intensity INTEGER DEFAULT 5`)
  } catch { /* 已存在 */ }

  // V2.6 写作技巧融合：章节 ABC 元数据与视角
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN beat_role VARCHAR(20)`)
  } catch { /* 已存在 */ }
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN foreshadow_target TEXT`)
  } catch { /* 已存在 */ }
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN next_hook TEXT`)
  } catch { /* 已存在 */ }
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN pov_mode VARCHAR(30)`)
  } catch { /* 已存在 */ }
  try {
    db.exec(`ALTER TABLE chapters ADD COLUMN characters TEXT`)
  } catch { /* 已存在 */ }

  // V2.7 核心设定版本管理与最近修改时间（幂等迁移见 migrations.ts）
  ensureIncrementalMigrations(db)

  // V2.0 增量迁移
  db.exec(`
    CREATE TABLE IF NOT EXISTS taste_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_name VARCHAR(50) NOT NULL,
      style_preferences TEXT,
      character_preferences TEXT,
      plot_preferences TEXT,
      pacing_preferences TEXT,
      reject_patterns TEXT,
      choice_history_summary TEXT,
      is_default INTEGER DEFAULT 0,
      extracted_from_work_id INTEGER,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (extracted_from_work_id) REFERENCES works(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS work_taste_relation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_id, profile_id),
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES taste_profile(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS style_deviation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      style_id INTEGER NOT NULL,
      deviation_score REAL,
      deviation_details TEXT,
      check_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS volcengine_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_key VARCHAR(200) NOT NULL,
      secret_key VARCHAR(200) NOT NULL,
      region VARCHAR(50) DEFAULT 'cn-beijing',
      is_enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS generated_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER,
      prompt TEXT NOT NULL,
      local_path VARCHAR(200) NOT NULL,
      image_type VARCHAR(20),
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER,
      category VARCHAR(30) NOT NULL,
      title VARCHAR(200),
      content TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

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

  console.log('[DB] Schema initialized (V2.9)')
}
