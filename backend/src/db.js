import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
const sqlitePath = path.join(dataDir, "app.sqlite");
const legacyJsonPath = path.join(dataDir, "database.json");

let database;
let initialized = false;

const now = () => new Date().toISOString();
const bool = (value) => (value ? 1 : 0);
const asBool = (value) => Boolean(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function mapUser(user) {
  return user ? { ...user, balance: Number(user.balance || 0) } : null;
}

function mapCharacter(character) {
  return character ? {
    ...character,
    price: Number(character.price || 0),
    usePrompt: asBool(character.usePrompt),
    useFirstMessage: asBool(character.useFirstMessage),
    useApiKey: asBool(character.useApiKey),
    usePrice: asBool(character.usePrice),
    enabled: asBool(character.enabled),
    isDefault: asBool(character.isDefault)
  } : null;
}

function mapApiKey(api) {
  return api ? { ...api, enabled: asBool(api.enabled) } : null;
}

function mapMessage(message, { includeRequestSnapshot = false } = {}) {
  if (!message) return null;
  return {
    ...message,
    thinkingDurationMs: message.thinkingDurationMs === null || message.thinkingDurationMs === undefined ? null : Number(message.thinkingDurationMs || 0),
    attachments: parseJson(message.attachments, []),
    requestSnapshot: includeRequestSnapshot ? parseJson(message.requestSnapshot, null) : null,
    usage: parseJson(message.usage, null)
  };
}

const emptyDb = () => ({
  users: [],
  admins: [],
  characters: [],
  apiKeys: [],
  sessions: [],
  messages: [],
  billings: [],
  promptSettings: null
});

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function getDatabase() {
  ensureDataDir();
  if (!database) {
    database = new DatabaseSync(sqlitePath);
    fs.chmodSync(sqlitePath, 0o600);
  }
  return database;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL,
      updatedAt TEXT,
      approvedAt TEXT,
      approvedBy TEXT,
      rejectedAt TEXT,
      rejectionReason TEXT
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS apiKeys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      apiUrl TEXT NOT NULL,
      apiKeySecret TEXT,
      reasoningEffort TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT,
      firstMessage TEXT,
      apiKeyId TEXT,
      price REAL NOT NULL DEFAULT 0,
      usePrompt INTEGER NOT NULL DEFAULT 1,
      useFirstMessage INTEGER NOT NULL DEFAULT 1,
      useApiKey INTEGER NOT NULL DEFAULT 0,
      usePrice INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      isDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      characterId TEXT NOT NULL,
      title TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      userId TEXT NOT NULL,
      characterId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      thinkingDurationMs INTEGER,
      attachments TEXT,
      requestSnapshot TEXT,
      usage TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promptSettings (
      id TEXT PRIMARY KEY,
      systemTemplate TEXT NOT NULL,
      historyStrategy TEXT NOT NULL DEFAULT 'recent_with_summary',
      maxHistoryMessages INTEGER NOT NULL DEFAULT 40,
      compressionThresholdMessages INTEGER NOT NULL DEFAULT 60,
      includeUserEnvironment INTEGER NOT NULL DEFAULT 1,
      includeAttachmentsInPrompt INTEGER NOT NULL DEFAULT 1,
      promptCacheRetention TEXT NOT NULL DEFAULT 'in_memory',
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS billings (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      characterId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_character ON sessions(userId, characterId, updatedAt);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_billings_character ON billings(characterId, createdAt);
  `);
  ensureColumn(db, "messages", "attachments", "TEXT");
  ensureColumn(db, "messages", "thinking", "TEXT");
  ensureColumn(db, "messages", "thinkingDurationMs", "INTEGER");
  ensureColumn(db, "messages", "requestSnapshot", "TEXT");
  ensureColumn(db, "apiKeys", "reasoningEffort", "TEXT NOT NULL DEFAULT ''");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function insertSnapshot(db, snapshot) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const data = snapshot;
    db.exec("DELETE FROM promptSettings; DELETE FROM billings; DELETE FROM messages; DELETE FROM sessions; DELETE FROM characters; DELETE FROM apiKeys; DELETE FROM users; DELETE FROM admins;");

    const insertAdmin = db.prepare(`
      INSERT INTO admins (id, username, passwordHash, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const admin of data.admins || []) {
      insertAdmin.run(admin.id, admin.username, admin.passwordHash, admin.createdAt || now(), admin.updatedAt || null);
    }

    const insertUser = db.prepare(`
      INSERT INTO users (id, username, email, passwordHash, balance, status, createdAt, updatedAt, approvedAt, approvedBy, rejectedAt, rejectionReason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const user of data.users || []) {
      insertUser.run(
        user.id,
        user.username,
        String(user.email || "").toLowerCase(),
        user.passwordHash,
        Number(user.balance || 0),
        user.status || "active",
        user.createdAt || now(),
        user.updatedAt || null,
        user.approvedAt || null,
        user.approvedBy || null,
        user.rejectedAt || null,
        user.rejectionReason || null
      );
    }

    const insertApi = db.prepare(`
      INSERT INTO apiKeys (id, name, model, apiUrl, apiKeySecret, reasoningEffort, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const api of data.apiKeys || []) {
      insertApi.run(api.id, api.name, api.model, api.apiUrl, api.apiKeySecret || "", api.reasoningEffort || "", bool(api.enabled !== false), api.createdAt || now(), api.updatedAt || null);
    }

    const insertCharacter = db.prepare(`
      INSERT INTO characters (id, name, prompt, firstMessage, apiKeyId, price, usePrompt, useFirstMessage, useApiKey, usePrice, enabled, isDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const character of data.characters || []) {
      insertCharacter.run(
        character.id,
        character.name,
        character.prompt || "",
        character.firstMessage || "",
        character.apiKeyId || "",
        Number(character.price || 0),
        bool(character.usePrompt !== false),
        bool(character.useFirstMessage !== false),
        bool(character.useApiKey),
        bool(character.usePrice !== false),
        bool(character.enabled !== false),
        bool(character.isDefault),
        character.createdAt || now(),
        character.updatedAt || null
      );
    }

    const insertSession = db.prepare(`
      INSERT INTO sessions (id, userId, characterId, title, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const session of data.sessions || []) {
      insertSession.run(session.id, session.userId, session.characterId, session.title || "新的聊天", session.createdAt || now(), session.updatedAt || session.createdAt || now());
    }

    const insertMessage = db.prepare(`
      INSERT INTO messages (id, sessionId, userId, characterId, role, content, thinking, thinkingDurationMs, attachments, requestSnapshot, usage, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const message of data.messages || []) {
      insertMessage.run(
        message.id,
        message.sessionId,
        message.userId,
        message.characterId,
        message.role,
        message.content || "",
        message.thinking || "",
        message.thinkingDurationMs === null || message.thinkingDurationMs === undefined ? null : Math.max(0, Math.round(Number(message.thinkingDurationMs) || 0)),
        message.attachments ? JSON.stringify(message.attachments) : null,
        message.requestSnapshot ? JSON.stringify(message.requestSnapshot) : null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.createdAt || now()
      );
    }

    if (data.promptSettings) {
      const insertPromptSettings = db.prepare(`
        INSERT INTO promptSettings (id, systemTemplate, historyStrategy, maxHistoryMessages, compressionThresholdMessages, includeUserEnvironment, includeAttachmentsInPrompt, promptCacheRetention, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertPromptSettings.run(
        "default",
        data.promptSettings.systemTemplate || "",
        data.promptSettings.historyStrategy || "recent_with_summary",
        Number(data.promptSettings.maxHistoryMessages || 40),
        Number(data.promptSettings.compressionThresholdMessages || 60),
        bool(data.promptSettings.includeUserEnvironment !== false),
        bool(data.promptSettings.includeAttachmentsInPrompt !== false),
        data.promptSettings.promptCacheRetention || "in_memory",
        data.promptSettings.updatedAt || now()
      );
    }

    const insertBilling = db.prepare(`
      INSERT INTO billings (id, userId, characterId, sessionId, messageId, amount, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const bill of data.billings || []) {
      insertBilling.run(bill.id, bill.userId, bill.characterId, bill.sessionId, bill.messageId, Number(bill.amount || 0), bill.createdAt || now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacyJson(db) {
  const hasRows = ["users", "admins", "characters", "apiKeys", "sessions", "messages", "billings"].some((table) => tableCount(db, table) > 0);
  if (hasRows || !fs.existsSync(legacyJsonPath)) return;

  const legacy = JSON.parse(fs.readFileSync(legacyJsonPath, "utf8"));
  insertSnapshot(db, { ...emptyDb(), ...legacy });
}

export function initializeDatabase() {
  if (initialized) return;
  const db = getDatabase();
  createSchema(db);
  migrateLegacyJson(db);
  initialized = true;
}

export function readDb() {
  initializeDatabase();
  const db = getDatabase();
  return {
    users: db.prepare("SELECT * FROM users").all().map((user) => ({ ...user, balance: Number(user.balance || 0) })),
    admins: db.prepare("SELECT * FROM admins").all(),
    characters: db.prepare("SELECT * FROM characters").all().map((character) => ({
      ...character,
      price: Number(character.price || 0),
      usePrompt: asBool(character.usePrompt),
      useFirstMessage: asBool(character.useFirstMessage),
      useApiKey: asBool(character.useApiKey),
      usePrice: asBool(character.usePrice),
      enabled: asBool(character.enabled),
      isDefault: asBool(character.isDefault)
    })),
    apiKeys: db.prepare("SELECT * FROM apiKeys").all().map((api) => ({ ...api, enabled: asBool(api.enabled) })),
    sessions: db.prepare("SELECT * FROM sessions").all(),
    messages: db.prepare("SELECT * FROM messages").all().map((message) => ({
      ...message,
      thinkingDurationMs: message.thinkingDurationMs === null || message.thinkingDurationMs === undefined ? null : Number(message.thinkingDurationMs || 0),
      attachments: message.attachments ? JSON.parse(message.attachments) : [],
      requestSnapshot: message.requestSnapshot ? JSON.parse(message.requestSnapshot) : null,
      usage: message.usage ? JSON.parse(message.usage) : null
    })),
    billings: db.prepare("SELECT * FROM billings").all().map((bill) => ({ ...bill, amount: Number(bill.amount || 0) })),
    promptSettings: readPromptSettings(db)
  };
}

function readPromptSettings(db) {
  const settings = db.prepare("SELECT * FROM promptSettings WHERE id = 'default'").get();
  if (!settings) return null;
  return {
    ...settings,
    maxHistoryMessages: Number(settings.maxHistoryMessages || 40),
    compressionThresholdMessages: Number(settings.compressionThresholdMessages || 60),
    includeUserEnvironment: asBool(settings.includeUserEnvironment),
    includeAttachmentsInPrompt: asBool(settings.includeAttachmentsInPrompt)
  };
}

function readyDb() {
  initializeDatabase();
  return getDatabase();
}

function runImmediate(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertMessageRow(db, message) {
  db.prepare(`
    INSERT INTO messages (id, sessionId, userId, characterId, role, content, thinking, thinkingDurationMs, attachments, requestSnapshot, usage, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    message.sessionId,
    message.userId,
    message.characterId,
    message.role,
    message.content || "",
    message.thinking || "",
    message.thinkingDurationMs === null || message.thinkingDurationMs === undefined ? null : Math.max(0, Math.round(Number(message.thinkingDurationMs) || 0)),
    jsonOrNull(message.attachments),
    jsonOrNull(message.requestSnapshot),
    jsonOrNull(message.usage),
    message.createdAt || now()
  );
}

export function getUserById(id) {
  const row = readyDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return mapUser(row);
}

export function getUserByEmail(email) {
  const row = readyDb().prepare("SELECT * FROM users WHERE lower(email) = ?").get(String(email || "").toLowerCase());
  return mapUser(row);
}

export function getAdminById(id) {
  return readyDb().prepare("SELECT * FROM admins WHERE id = ?").get(id) || null;
}

export function getAdminByUsername(username) {
  return readyDb().prepare("SELECT * FROM admins WHERE username = ?").get(username) || null;
}

export function listAdmins() {
  return readyDb().prepare("SELECT * FROM admins").all();
}

export function hasStoredApiKeySecret() {
  const row = readyDb().prepare("SELECT 1 AS found FROM apiKeys WHERE apiKeySecret IS NOT NULL AND apiKeySecret != '' LIMIT 1").get();
  return Boolean(row);
}

export function emailExists(email) {
  const row = readyDb().prepare("SELECT 1 AS found FROM users WHERE lower(email) = ? LIMIT 1").get(String(email || "").toLowerCase());
  return Boolean(row);
}

export function insertUser(user) {
  const db = readyDb();
  db.prepare(`
    INSERT INTO users (id, username, email, passwordHash, balance, status, createdAt, updatedAt, approvedAt, approvedBy, rejectedAt, rejectionReason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id,
    user.username,
    String(user.email || "").toLowerCase(),
    user.passwordHash,
    Number(user.balance || 0),
    user.status || "active",
    user.createdAt || now(),
    user.updatedAt || null,
    user.approvedAt || null,
    user.approvedBy || null,
    user.rejectedAt || null,
    user.rejectionReason || null
  );
}

export function listEnabledPublicCharacters() {
  return readyDb().prepare(`
    SELECT id, name, firstMessage, price, usePrompt, useFirstMessage, useApiKey, usePrice, enabled, isDefault, createdAt, updatedAt
    FROM characters
    WHERE enabled = 1
    ORDER BY isDefault DESC, createdAt ASC
  `).all().map(mapCharacter);
}

export function listCharacters() {
  return readyDb().prepare("SELECT * FROM characters ORDER BY isDefault DESC, createdAt ASC").all().map(mapCharacter);
}

export function getCharacterById(id) {
  return mapCharacter(readyDb().prepare("SELECT * FROM characters WHERE id = ?").get(id));
}

export function getEnabledCharacterById(id) {
  return mapCharacter(readyDb().prepare("SELECT * FROM characters WHERE id = ? AND enabled = 1").get(id));
}

export function listSessionsForUserCharacter(userId, characterId) {
  const db = readyDb();
  const sql = characterId
    ? "SELECT * FROM sessions WHERE userId = ? AND characterId = ? ORDER BY updatedAt DESC"
    : "SELECT * FROM sessions WHERE userId = ? ORDER BY updatedAt DESC";
  return characterId ? db.prepare(sql).all(userId, characterId) : db.prepare(sql).all(userId);
}

export function getSessionForUser(sessionId, userId) {
  return readyDb().prepare("SELECT * FROM sessions WHERE id = ? AND userId = ?").get(sessionId, userId) || null;
}

export function getSessionById(sessionId) {
  return readyDb().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) || null;
}

export function getMessagesForSession(sessionId, options = {}) {
  const { includeRequestSnapshot = false, limit = null } = options;
  const db = readyDb();
  const rows = limit
    ? db.prepare("SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?").all(sessionId, Math.max(1, Number(limit)))
    : db.prepare("SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt ASC").all(sessionId);
  const orderedRows = limit ? rows.reverse() : rows;
  return orderedRows.map((message) => mapMessage(message, { includeRequestSnapshot }));
}

export function getMessagesForPrompt(sessionId, { maxHistoryMessages = 40, compressionThresholdMessages = 60 } = {}) {
  const limit = Math.max(1, Number(maxHistoryMessages || 40)) + Math.max(1, Number(compressionThresholdMessages || 60));
  return getMessagesForSession(sessionId, { limit });
}

export function createSessionWithMessages(session, messages = []) {
  const db = readyDb();
  runImmediate(db, () => {
    db.prepare(`
      INSERT INTO sessions (id, userId, characterId, title, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, session.userId, session.characterId, session.title || "新的聊天", session.createdAt || now(), session.updatedAt || session.createdAt || now());
    for (const message of messages) insertMessageRow(db, message);
  });
}

export function saveUserChatMessage(userMessage, title) {
  const db = readyDb();
  return runImmediate(db, () => {
    insertMessageRow(db, userMessage);
    db.prepare(`
      UPDATE sessions
      SET updatedAt = ?, title = CASE WHEN title = '新的聊天' THEN ? ELSE title END
      WHERE id = ? AND userId = ?
    `).run(userMessage.createdAt || now(), title || "新的聊天", userMessage.sessionId, userMessage.userId);
    return db.prepare("SELECT * FROM sessions WHERE id = ?").get(userMessage.sessionId);
  });
}

export function findApiForCharacter(character) {
  const db = readyDb();
  const id = character?.useApiKey ? character.apiKeyId : "api_default";
  return mapApiKey(db.prepare("SELECT * FROM apiKeys WHERE id = ? AND enabled = 1").get(id));
}

export function readPromptSettingsForRuntime() {
  return readPromptSettings(readyDb());
}

export function saveAssistantChatResult({ assistantMessage, userId, sessionId, amount, billing }) {
  const db = readyDb();
  return runImmediate(db, () => {
    const user = mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
    if (!user) throw new Error("用户不存在");
    const nextBalance = Math.max(0, Number(user.balance || 0) - Math.max(0, Number(amount || 0)));

    insertMessageRow(db, assistantMessage);
    db.prepare("UPDATE users SET balance = ?, updatedAt = ? WHERE id = ?").run(nextBalance, now(), userId);
    db.prepare("UPDATE sessions SET updatedAt = ? WHERE id = ?").run(now(), sessionId);
    db.prepare(`
      INSERT INTO billings (id, userId, characterId, sessionId, messageId, amount, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      billing.id,
      billing.userId,
      billing.characterId,
      billing.sessionId,
      billing.messageId,
      Number(billing.amount || 0),
      billing.createdAt || now()
    );

    return { balance: nextBalance };
  });
}

export function getAdminStats(sinceIso) {
  const db = readyDb();
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE status = 'pending') AS pendingUsers,
      (SELECT COUNT(*) FROM admins) AS admins,
      (SELECT COUNT(*) FROM characters) AS characters,
      (SELECT COUNT(*) FROM apiKeys) AS apiKeys,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COALESCE(SUM(amount), 0) FROM billings) AS totalSpend,
      (SELECT COUNT(*) FROM users WHERE createdAt >= ?) AS todayUsers,
      (SELECT COUNT(*) FROM messages WHERE role = 'user' AND createdAt >= ?) AS todayChats
  `).get(sinceIso, sinceIso);
}

export function listUsers(query = "") {
  const db = readyDb();
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return db.prepare("SELECT * FROM users ORDER BY createdAt DESC").all().map(mapUser);
  const like = `%${normalized}%`;
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(id) LIKE ? OR lower(username) LIKE ? OR lower(email) LIKE ?
    ORDER BY createdAt DESC
  `).all(like, like, like).map(mapUser);
}

export function updateUser(id, patch) {
  const db = readyDb();
  const user = mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  if (!user) return null;
  const next = { ...user, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE users
    SET username = ?, email = ?, balance = ?, updatedAt = ?
    WHERE id = ?
  `).run(next.username, next.email, Number(next.balance || 0), next.updatedAt, id);
  return getUserById(id);
}

export function setUserApproval(id, patch) {
  const db = readyDb();
  const user = mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  if (!user) return null;
  db.prepare(`
    UPDATE users
    SET status = ?, approvedAt = ?, approvedBy = ?, rejectedAt = ?, rejectionReason = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    patch.status,
    hasOwn(patch, "approvedAt") ? patch.approvedAt : user.approvedAt ?? null,
    hasOwn(patch, "approvedBy") ? patch.approvedBy : user.approvedBy ?? null,
    hasOwn(patch, "rejectedAt") ? patch.rejectedAt : user.rejectedAt ?? null,
    hasOwn(patch, "rejectionReason") ? patch.rejectionReason : user.rejectionReason ?? null,
    now(),
    id
  );
  return getUserById(id);
}

export function deleteUserCascade(id) {
  const db = readyDb();
  return runImmediate(db, () => {
    db.prepare("DELETE FROM messages WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ?)").run(id);
    db.prepare("DELETE FROM billings WHERE userId = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE userId = ?").run(id);
    const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  });
}

export function listUserHistorySessions(userId, characterId = "") {
  const db = readyDb();
  const sql = characterId
    ? `SELECT s.*, COUNT(m.id) AS messageCount
       FROM sessions s
       LEFT JOIN messages m ON m.sessionId = s.id
       WHERE s.userId = ? AND s.characterId = ?
       GROUP BY s.id
       ORDER BY s.updatedAt DESC`
    : `SELECT s.*, COUNT(m.id) AS messageCount
       FROM sessions s
       LEFT JOIN messages m ON m.sessionId = s.id
       WHERE s.userId = ?
       GROUP BY s.id
       ORDER BY s.updatedAt DESC`;
  return characterId ? db.prepare(sql).all(userId, characterId) : db.prepare(sql).all(userId);
}

export function getApiKeyById(id) {
  return mapApiKey(readyDb().prepare("SELECT * FROM apiKeys WHERE id = ?").get(id));
}

export function upsertPromptSettings(settings) {
  const db = readyDb();
  db.prepare(`
    INSERT INTO promptSettings (id, systemTemplate, historyStrategy, maxHistoryMessages, compressionThresholdMessages, includeUserEnvironment, includeAttachmentsInPrompt, promptCacheRetention, updatedAt)
    VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      systemTemplate = excluded.systemTemplate,
      historyStrategy = excluded.historyStrategy,
      maxHistoryMessages = excluded.maxHistoryMessages,
      compressionThresholdMessages = excluded.compressionThresholdMessages,
      includeUserEnvironment = excluded.includeUserEnvironment,
      includeAttachmentsInPrompt = excluded.includeAttachmentsInPrompt,
      promptCacheRetention = excluded.promptCacheRetention,
      updatedAt = excluded.updatedAt
  `).run(
    settings.systemTemplate,
    settings.historyStrategy,
    Number(settings.maxHistoryMessages || 40),
    Number(settings.compressionThresholdMessages || 60),
    bool(settings.includeUserEnvironment !== false),
    bool(settings.includeAttachmentsInPrompt !== false),
    settings.promptCacheRetention || "in_memory",
    settings.updatedAt || now()
  );
  return readPromptSettings(db);
}

export function insertCharacter(character) {
  const db = readyDb();
  db.prepare(`
    INSERT INTO characters (id, name, prompt, firstMessage, apiKeyId, price, usePrompt, useFirstMessage, useApiKey, usePrice, enabled, isDefault, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    character.id,
    character.name,
    character.prompt || "",
    character.firstMessage || "",
    character.apiKeyId || "",
    Number(character.price || 0),
    bool(character.usePrompt !== false),
    bool(character.useFirstMessage !== false),
    bool(character.useApiKey),
    bool(character.usePrice !== false),
    bool(character.enabled !== false),
    bool(character.isDefault),
    character.createdAt || now(),
    character.updatedAt || null
  );
}

export function updateCharacter(id, patch) {
  const current = getCharacterById(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: now() };
  readyDb().prepare(`
    UPDATE characters
    SET name = ?, prompt = ?, firstMessage = ?, apiKeyId = ?, price = ?, usePrompt = ?, useFirstMessage = ?, useApiKey = ?, usePrice = ?, enabled = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    current.isDefault ? "默认模型" : next.name,
    next.prompt || "",
    next.firstMessage || "",
    next.apiKeyId || "",
    Number(next.price || 0),
    bool(next.usePrompt),
    bool(next.useFirstMessage),
    bool(next.useApiKey),
    bool(next.usePrice),
    bool(next.enabled),
    next.updatedAt,
    id
  );
  return getCharacterById(id);
}

export function deleteCharacter(id) {
  const db = readyDb();
  const character = getCharacterById(id);
  if (!character || character.isDefault) return false;
  return db.prepare("DELETE FROM characters WHERE id = ?").run(id).changes > 0;
}

export function listApiKeys() {
  return readyDb().prepare("SELECT * FROM apiKeys ORDER BY createdAt ASC").all().map(mapApiKey);
}

export function insertApiKey(apiKey) {
  const db = readyDb();
  db.prepare(`
    INSERT INTO apiKeys (id, name, model, apiUrl, apiKeySecret, reasoningEffort, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(apiKey.id, apiKey.name, apiKey.model, apiKey.apiUrl, apiKey.apiKeySecret || "", apiKey.reasoningEffort || "", bool(apiKey.enabled !== false), apiKey.createdAt || now(), apiKey.updatedAt || null);
}

export function updateApiKey(id, patch) {
  const current = getApiKeyById(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: now() };
  const secret = patch.apiKeySecret ? patch.apiKeySecret : current.apiKeySecret;
  readyDb().prepare(`
    UPDATE apiKeys
    SET name = ?, model = ?, apiUrl = ?, apiKeySecret = ?, reasoningEffort = ?, enabled = ?, updatedAt = ?
    WHERE id = ?
  `).run(next.name, next.model, next.apiUrl, secret || "", next.reasoningEffort || "", bool(next.enabled), next.updatedAt, id);
  return getApiKeyById(id);
}

export function listCharactersUsingApiKey(apiKeyId) {
  return readyDb().prepare("SELECT * FROM characters WHERE apiKeyId = ? ORDER BY name ASC").all(apiKeyId).map(mapCharacter);
}

export function deleteApiKey(id) {
  return readyDb().prepare("DELETE FROM apiKeys WHERE id = ?").run(id).changes > 0;
}

export function listBillingByCharacter() {
  const db = readyDb();
  return db.prepare(`
    SELECT
      c.id AS characterId,
      c.name AS characterName,
      COUNT(b.id) AS calls,
      COALESCE(SUM(b.amount), 0) AS amount
    FROM characters c
    LEFT JOIN billings b ON b.characterId = c.id
    GROUP BY c.id
    ORDER BY c.createdAt ASC
  `).all().map((row) => ({
    ...row,
    calls: Number(row.calls || 0),
    amount: Number(row.amount || 0)
  }));
}

export function writeDb(db) {
  initializeDatabase();
  insertSnapshot(getDatabase(), { ...emptyDb(), ...db });
  fs.chmodSync(sqlitePath, 0o600);
}

export function uid(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export async function seedDb() {
  initializeDatabase();
  const db = readDb();
  const createdAt = now();

  if (!db.admins.some((admin) => admin.username === (process.env.ADMIN_USERNAME || "admin"))) {
    db.admins.push({
      id: "admin_default",
      username: process.env.ADMIN_USERNAME || "admin",
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 10),
      createdAt,
      updatedAt: createdAt
    });
  }

  if (!db.apiKeys.some((api) => api.id === "api_default")) {
    db.apiKeys.push({
      id: "api_default",
      name: "默认 OpenAI",
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      apiUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKeySecret: process.env.OPENAI_API_KEY || "",
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "",
      enabled: true,
      createdAt,
      updatedAt: createdAt
    });
  }

  if (!db.characters.some((character) => character.id === "character_default")) {
    db.characters.push({
      id: "character_default",
      name: "默认模型",
      prompt: "你是一个友好、可靠的 AI 助手。回答时保持清晰、有帮助，并优先使用用户的语言。",
      firstMessage: "",
      apiKeyId: "api_default",
      price: Number(process.env.DEFAULT_CHARACTER_PRICE || 1),
      usePrompt: true,
      useFirstMessage: true,
      useApiKey: true,
      usePrice: true,
      enabled: true,
      isDefault: true,
      createdAt,
      updatedAt: createdAt
    });
  }

  writeDb(db);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

export function publicAdmin(admin) {
  if (!admin) return null;
  const { passwordHash, ...safe } = admin;
  return safe;
}

export function publicApiKey(apiKey) {
  if (!apiKey) return null;
  const { apiKeySecret, ...safe } = apiKey;
  return {
    ...safe,
    hasSecret: Boolean(apiKeySecret)
  };
}

export { now, sqlitePath, legacyJsonPath };
