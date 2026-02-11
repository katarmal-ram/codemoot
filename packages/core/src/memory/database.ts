// packages/core/src/memory/database.ts

import Database from 'better-sqlite3';
import { DatabaseError } from '../utils/errors.js';

const SCHEMA_VERSION = '8';

const MIGRATIONS = [
  // Sessions
  `CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    task          TEXT NOT NULL,
    workflow_id   TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'autonomous',
    status        TEXT NOT NULL DEFAULT 'running',
    config_snapshot TEXT,
    current_step  TEXT,
    summary       TEXT,
    total_tokens  INTEGER DEFAULT 0,
    total_cost    REAL DEFAULT 0,
    started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at  DATETIME,
    metadata      JSON
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC)',

  // Messages (transcript entries)
  `CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    step_id       TEXT,
    iteration     INTEGER,
    role          TEXT NOT NULL,
    model_id      TEXT,
    content       TEXT NOT NULL,
    token_count   INTEGER,
    cost          REAL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata      JSON
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_step ON messages(session_id, step_id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role)',

  // Artifacts
  `CREATE TABLE IF NOT EXISTS artifacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    step_id       TEXT NOT NULL,
    iteration     INTEGER NOT NULL DEFAULT 1,
    type          TEXT NOT NULL,
    file_path     TEXT,
    content       TEXT NOT NULL,
    version       INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata      JSON
  )`,
  'CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_artifacts_step ON artifacts(session_id, step_id)',

  // Decisions
  `CREATE TABLE IF NOT EXISTS decisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    step_id       TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    reason        TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id)',

  // Memories
  `CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        TEXT NOT NULL,
    category          TEXT NOT NULL,
    content           TEXT NOT NULL,
    source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    importance        REAL DEFAULT 0.5,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    accessed_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    access_count      INTEGER DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project_id, category)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)',

  // Memories FTS5
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    category,
    content='memories',
    content_rowid='id'
  )`,

  // FTS sync triggers
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category)
    VALUES (new.id, new.content, new.category);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category)
    VALUES ('delete', old.id, old.content, old.category);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category)
    VALUES ('delete', old.id, old.content, old.category);
    INSERT INTO memories_fts(rowid, content, category)
    VALUES (new.id, new.content, new.category);
  END`,

  // Cost log
  `CREATE TABLE IF NOT EXISTS cost_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    step_id       TEXT,
    model_id      TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_log(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_cost_model ON cost_log(model_id)',
  'CREATE INDEX IF NOT EXISTS idx_cost_date ON cost_log(created_at)',

  // Debate turns (session resume persistence)
  `CREATE TABLE IF NOT EXISTS debate_turns (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    debate_id         TEXT NOT NULL,
    role              TEXT NOT NULL,
    codex_session_id  TEXT,
    round             INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'active',
    resume_fail_count INTEGER DEFAULT 0,
    last_activity_at  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    state_json        TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_turns_unique ON debate_turns(debate_id, role)',
  'CREATE INDEX IF NOT EXISTS idx_debate_turns_status ON debate_turns(status)',
  'CREATE INDEX IF NOT EXISTS idx_debate_turns_activity ON debate_turns(last_activity_at)',

  // Build runs (automated build loop sessions)
  `CREATE TABLE IF NOT EXISTS build_runs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    build_id              TEXT NOT NULL UNIQUE,
    task                  TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'planning',
    current_phase         TEXT NOT NULL DEFAULT 'debate',
    current_loop          INTEGER NOT NULL DEFAULT 0,
    last_event_seq        INTEGER NOT NULL DEFAULT 0,
    phase_cursor          TEXT NOT NULL DEFAULT '{}',
    debate_id             TEXT,
    baseline_ref          TEXT,
    plan_codex_session    TEXT,
    review_codex_session  TEXT,
    plan_version          INTEGER DEFAULT 0,
    review_cycles         INTEGER DEFAULT 0,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    completed_at          INTEGER,
    metadata              TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_build_runs_status ON build_runs(status)',
  'CREATE INDEX IF NOT EXISTS idx_build_runs_updated ON build_runs(updated_at DESC)',

  // Build events (append-only log)
  `CREATE TABLE IF NOT EXISTS build_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    build_id          TEXT NOT NULL,
    seq               INTEGER NOT NULL,
    event_type        TEXT NOT NULL,
    actor             TEXT NOT NULL,
    phase             TEXT NOT NULL,
    loop_index        INTEGER DEFAULT 0,
    payload           TEXT,
    codex_thread_id   TEXT,
    tokens_used       INTEGER DEFAULT 0,
    created_at        INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_build_events_build ON build_events(build_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_build_events_type ON build_events(build_id, event_type)',

  // Debate messages (full conversation persistence)
  `CREATE TABLE IF NOT EXISTS debate_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    debate_id     TEXT NOT NULL,
    round         INTEGER NOT NULL CHECK(round >= 0),
    role          TEXT NOT NULL,
    bridge        TEXT NOT NULL DEFAULT 'codex',
    model         TEXT NOT NULL,
    prompt_text   TEXT NOT NULL,
    response_text TEXT,
    stance        TEXT CHECK(stance IN ('SUPPORT','OPPOSE','UNCERTAIN') OR stance IS NULL),
    confidence    REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    verdict_raw   TEXT,
    usage_json    TEXT,
    duration_ms   INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
    session_id    TEXT,
    status        TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
    error         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    completed_at  INTEGER
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_unique ON debate_messages(debate_id, round, role)',
  'CREATE INDEX IF NOT EXISTS idx_dm_debate ON debate_messages(debate_id)',
  'CREATE INDEX IF NOT EXISTS idx_dm_status ON debate_messages(status)',

  // Unified sessions (one codex thread per session)
  `CREATE TABLE IF NOT EXISTS codemoot_sessions (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    codex_thread_id TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','stale')),
    token_usage     INTEGER DEFAULT 0,
    max_context     INTEGER DEFAULT 400000,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    completed_at    INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_csess_status ON codemoot_sessions(status)',
  'CREATE INDEX IF NOT EXISTS idx_csess_updated ON codemoot_sessions(updated_at DESC)',

  // Session events (append-only audit trail of every GPT interaction)
  `CREATE TABLE IF NOT EXISTS session_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES codemoot_sessions(id),
    command         TEXT NOT NULL,
    subcommand      TEXT,
    prompt_preview  TEXT,
    response_preview TEXT,
    usage_json      TEXT,
    duration_ms     INTEGER,
    codex_thread_id TEXT,
    created_at      INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sevt_session ON session_events(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_sevt_command ON session_events(session_id, command)',

  // Add session_id to debate_messages (nullable for backward compat)
  // Note: SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we use a pragma check approach
  // For new DBs this column is in the CREATE TABLE; for upgrades we add it via ALTER TABLE below

  // Jobs queue (background async work)
  `CREATE TABLE IF NOT EXISTS jobs (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'queued',
    priority          INTEGER NOT NULL DEFAULT 100,
    dedupe_key        TEXT,
    payload_json      TEXT NOT NULL,
    result_json       TEXT,
    error_text        TEXT,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    max_retries       INTEGER NOT NULL DEFAULT 1,
    session_id        TEXT,
    worker_id         TEXT,
    started_at        INTEGER,
    finished_at       INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON jobs(status, priority, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id)',

  // Job logs (append-only log per job)
  `CREATE TABLE IF NOT EXISTS job_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    level        TEXT NOT NULL DEFAULT 'info',
    event_type   TEXT NOT NULL,
    message      TEXT,
    payload_json TEXT,
    created_at   INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_job_logs_job_seq ON job_logs(job_id, seq)',

  // Cache entries
  `CREATE TABLE IF NOT EXISTS cache_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL,
    kind         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    config_hash  TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    value_json   TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    hit_count    INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_key ON cache_entries(key)',
  'CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at)',

  // Schema meta
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * Open a SQLite database and run migrations.
 * Pass ':memory:' for in-memory databases (testing).
 */
export function openDatabase(dbPath: string): Database.Database {
  try {
    const db = new Database(dbPath);
    configurePragmas(db);
    runMigrations(db);
    return db;
  } catch (err) {
    throw new DatabaseError(
      `Failed to open database at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`,
      'open',
    );
  }
}

function configurePragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/**
 * Run all schema migrations. Idempotent (uses IF NOT EXISTS).
 */
export function runMigrations(db: Database.Database): void {
  db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
    // Add codemoot_session_id columns to existing tables (safe: silently fails if already exists)
    for (const table of ['debate_messages', 'build_events']) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN codemoot_session_id TEXT`);
      } catch {
        // Column already exists — expected on fresh DBs
      }
    }

    // v8: Add full prompt/response storage to session_events
    for (const col of ['prompt_full', 'response_full']) {
      try {
        db.exec(`ALTER TABLE session_events ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists
      }
    }

    // Set schema version
    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', ?)").run(
      SCHEMA_VERSION,
    );
    db.prepare(
      "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('created_at', datetime('now'))",
    ).run();
  })();
}

/** Get the current schema version. */
export function getSchemaVersion(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
