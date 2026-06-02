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
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
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
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

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
      snapshot_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
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
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_taste_relation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_id, profile_id)
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
      work_id INTEGER,
      chapter_id INTEGER,
      prompt TEXT NOT NULL,
      local_path VARCHAR(200) NOT NULL,
      image_type VARCHAR(20),
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `)

  console.log('[DB] Schema initialized (V2.8)')
}
