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

    CREATE TABLE IF NOT EXISTS story_reader_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      release_snapshot_id INTEGER NOT NULL,
      source VARCHAR(50) NOT NULL,
      impressions INTEGER NOT NULL,
      opened_reads INTEGER NOT NULL,
      preview_completions INTEGER NOT NULL,
      completions INTEGER NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      comments INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      follows INTEGER NOT NULL DEFAULT 0,
      avg_read_seconds REAL,
      notes TEXT,
      collected_at DATETIME NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (release_snapshot_id) REFERENCES story_release_snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_story_reader_feedback_work
      ON story_reader_feedback(work_id, release_snapshot_id, collected_at);

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
    -- 长篇小说首发窗口：每八章全量审读 / 问题账本 / 发布快照（V5.1）
    -- ============================================
    CREATE TABLE IF NOT EXISTS novel_release_window_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      start_chapter_id INTEGER NOT NULL,
      end_chapter_id INTEGER NOT NULL,
      start_index INTEGER NOT NULL,
      end_index INTEGER NOT NULL,
      source_hash VARCHAR(64) NOT NULL,
      authority_revision INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      overall_score INTEGER,
      scores_json TEXT NOT NULL DEFAULT '{}',
      blocker_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (start_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (end_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_novel_release_window_lookup
      ON novel_release_window_audits(work_id, start_index, end_index, source_hash, status);

    CREATE TABLE IF NOT EXISTS novel_release_window_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER NOT NULL,
      code VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      chapter_ids_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      message TEXT NOT NULL,
      required_fix TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (audit_id) REFERENCES novel_release_window_audits(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_novel_release_window_issue_audit
      ON novel_release_window_issues(audit_id, severity, status);

    CREATE TABLE IF NOT EXISTS novel_release_window_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER NOT NULL UNIQUE,
      work_id INTEGER NOT NULL,
      source_hash VARCHAR(64) NOT NULL,
      proof_json TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (audit_id) REFERENCES novel_release_window_audits(id) ON DELETE CASCADE,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_novel_release_window_snapshot_work
      ON novel_release_window_snapshots(work_id, id DESC);

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

    CREATE TABLE IF NOT EXISTS chapter_emotion_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      content_hash VARCHAR(80) NOT NULL,
      stage VARCHAR(30) NOT NULL,
      batch_key VARCHAR(160) NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL,
      payload_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      failure_code VARCHAR(80),
      failure_message TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      UNIQUE(chapter_id, content_hash, stage, batch_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_emotion_checkpoint_lookup
      ON chapter_emotion_checkpoints(chapter_id, content_hash, stage, status);

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
    -- 滚动因果小说：权威状态与逐章决策事务
    -- ============================================
    CREATE TABLE IF NOT EXISTS causal_narrative_states (
      work_id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS causal_state_revisions (
      work_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      source_chapter_id INTEGER,
      transition_type VARCHAR(40) NOT NULL,
      body_hash VARCHAR(64),
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (work_id, revision),
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_causal_state_revisions_chapter
      ON causal_state_revisions(work_id, source_chapter_id, revision);

    CREATE TABLE IF NOT EXISTS causal_chapter_decisions (
      chapter_id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      state_revision INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL,
      outcome_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_causal_decisions_work_status
      ON causal_chapter_decisions(work_id, status, chapter_id);

    CREATE TABLE IF NOT EXISTS causal_plan_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      state_revision INTEGER NOT NULL,
      stage VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL,
      error_code VARCHAR(50),
      error_message TEXT,
      response_hash VARCHAR(64),
      response_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_causal_plan_attempts_work
      ON causal_plan_attempts(work_id, state_revision, id);

    -- 因果正文采用不可变版本。chapters.content 只是当前投影视图，不能作为历史身份。
    CREATE TABLE IF NOT EXISTS causal_content_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      parent_version_id INTEGER,
      body_hash VARCHAR(64) NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      source VARCHAR(30) NOT NULL DEFAULT 'system',
      edit_kind VARCHAR(20) NOT NULL DEFAULT 'generated',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_version_id) REFERENCES causal_content_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_content_versions_chapter
      ON causal_content_versions(work_id, chapter_id, id DESC);

    CREATE TABLE IF NOT EXISTS causal_chapter_bindings (
      chapter_id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      content_version_id INTEGER NOT NULL,
      state_before_revision INTEGER,
      state_after_revision INTEGER,
      decision_status VARCHAR(20) NOT NULL,
      binding_status VARCHAR(24) NOT NULL DEFAULT 'active',
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (content_version_id) REFERENCES causal_content_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_chapter_bindings_work
      ON causal_chapter_bindings(work_id, binding_status, chapter_id);

    CREATE TABLE IF NOT EXISTS causal_stage_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      content_version_id INTEGER NOT NULL,
      body_hash VARCHAR(64) NOT NULL,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      stage VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL,
      payload_json TEXT,
      error_message TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chapter_id, content_version_id, protocol_version, stage),
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (content_version_id) REFERENCES causal_content_versions(id)
    );

    CREATE TABLE IF NOT EXISTS causal_replay_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      base_state_revision INTEGER NOT NULL,
      source_version_id INTEGER NOT NULL,
      target_version_id INTEGER NOT NULL,
      edit_kind VARCHAR(20) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      affected_chapters_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (source_version_id) REFERENCES causal_content_versions(id),
      FOREIGN KEY (target_version_id) REFERENCES causal_content_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_replay_jobs_work_status
      ON causal_replay_jobs(work_id, status, id);

    CREATE TABLE IF NOT EXISTS causal_outcome_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      content_version_id INTEGER NOT NULL,
      replay_job_id INTEGER,
      state_before_revision INTEGER NOT NULL,
      state_after_revision INTEGER NOT NULL,
      outcome_json TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
      FOREIGN KEY (content_version_id) REFERENCES causal_content_versions(id),
      FOREIGN KEY (replay_job_id) REFERENCES causal_replay_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_outcome_versions_chapter
      ON causal_outcome_versions(work_id, chapter_id, id DESC);

    CREATE TABLE IF NOT EXISTS causal_replay_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_job_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      conflict_type VARCHAR(40) NOT NULL,
      message TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (replay_job_id) REFERENCES causal_replay_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );

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
