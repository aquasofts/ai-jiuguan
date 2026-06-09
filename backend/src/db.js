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
      INSERT INTO messages (id, sessionId, userId, characterId, role, content, attachments, requestSnapshot, usage, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const message of data.messages || []) {
      insertMessage.run(
        message.id,
        message.sessionId,
        message.userId,
        message.characterId,
        message.role,
        message.content || "",
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
