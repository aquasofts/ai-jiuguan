import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { readDb, writeDb, seedDb, uid, now, publicUser, publicApiKey } from "./db.js";
import { requireUser, requireAdmin, signUser, signAdmin } from "./auth.js";
import {
  buildInstructions,
  buildModelInput,
  buildRequestSnapshot,
  defaultPromptSettings,
  mergePromptSettings,
  normalizeAttachments,
  normalizeClientContext,
  streamOpenAIResponse
} from "./openai-response.js";
import {
  assertSafeStartup,
  envBool,
  envNumber,
  isStrongEnoughPassword,
  isValidEmail,
  makeRateLimiter,
  sanitizeString,
  securityHeaders,
  validatePublicBaseUrl,
  withUserChatLock
} from "./security.js";

const app = express();
const port = Number(process.env.PORT || 2255);
const host = process.env.HOST || "127.0.0.1";
const maxMessageChars = envNumber("MAX_MESSAGE_CHARS", 8000, { min: 100, max: 50000 });
const maxHistoryMessages = envNumber("MAX_HISTORY_MESSAGES", 40, { min: 1, max: 200 });
const maxOutputTokens = envNumber("MAX_OUTPUT_TOKENS", 2048, { min: 64, max: 16000 });
const maxAttachmentFiles = envNumber("MAX_ATTACHMENT_FILES", 5, { min: 0, max: 10 });
const maxAttachmentTextChars = envNumber("MAX_ATTACHMENT_TEXT_CHARS", 60000, { min: 1000, max: 200000 });
const userInitialBalance = envNumber("USER_INITIAL_BALANCE", 0, { min: 0, max: 1000000 });
const allowFreeAiCalls = envBool("ALLOW_FREE_AI_CALLS", false);

assertSafeStartup();
app.disable("x-powered-by");

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
    process.env.USER_FRONTEND_ORIGIN || "http://localhost:5173",
    process.env.ADMIN_FRONTEND_ORIGIN || "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174"
    ];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(new Error("CORS origin not allowed"));
  },
  credentials: true
}));
app.use(securityHeaders);
app.use(express.json({ limit: "8mb" }));
app.use("/api", makeRateLimiter({ windowMs: 60_000, max: 240 }));

const authLimiter = makeRateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  key: (req) => `auth:${req.ip}`,
  message: "登录或注册尝试过于频繁，请稍后再试"
});

const chatLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: envNumber("CHAT_RATE_LIMIT_PER_MINUTE", 10, { min: 1, max: 120 }),
  key: (req) => `chat:${req.user?.id || req.ip}`,
  message: "聊天请求过于频繁，请稍后再试"
});

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function userSessions(db, userId, characterId) {
  return db.sessions
    .filter((session) => session.userId === userId && session.characterId === characterId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function messagesForSession(db, sessionId) {
  return db.messages
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function jwtSecretIsWeak() {
  const value = process.env.JWT_SECRET || "";
  return !value || value === "replace-with-a-long-random-string" || value === "dev-secret-change-me" || value === "please-generate-a-random-secret-at-least-32-chars" || value.length < 32;
}

async function assertAdminCredentialSafety(db) {
  if (envBool("ALLOW_INSECURE_DEFAULTS", false)) return;

  if (jwtSecretIsWeak()) {
    throw new Error("保存或使用真实 API Key 前必须设置长度至少 32 位的 JWT_SECRET");
  }

  const unsafePasswords = ["admin123", "please-change-this-admin-password"];
  for (const admin of db.admins) {
    for (const password of unsafePasswords) {
      if (await bcrypt.compare(password, admin.passwordHash)) {
        throw new Error("保存或使用真实 API Key 前必须修改默认管理员密码");
      }
    }
  }
}

async function assertStoredApiKeysAreSafe() {
  const db = readDb();
  const hasStoredKey = db.apiKeys.some((api) => api.apiKeySecret) || Boolean(process.env.OPENAI_API_KEY);
  if (hasStoredKey) await assertAdminCredentialSafety(db);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: now() });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = sanitizeString(req.body.email, 254).toLowerCase();
  const username = sanitizeString(req.body.username || email.split("@")[0], 40);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "邮箱和密码必填" });
  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱格式不正确" });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ message: "密码长度需要在 8 到 128 位之间" });

  const db = readDb();
  if (db.users.some((user) => user.email.toLowerCase() === email)) {
    return res.status(409).json({ message: "邮箱已注册" });
  }

  const createdAt = now();
  const user = {
    id: uid("user"),
    username,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    balance: userInitialBalance,
    status: "pending",
    createdAt,
    updatedAt: createdAt
  };
  db.users.push(user);
  writeDb(db);

  res.json({ pendingApproval: true, message: "注册申请已提交，请等待管理员审核" });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = sanitizeString(req.body.email, 254).toLowerCase();
  const { password } = req.body;
  const db = readDb();
  const user = db.users.find((item) => item.email.toLowerCase() === email);
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    return res.status(401).json({ message: "邮箱或密码错误" });
  }
  if (user.status === "pending") return res.status(403).json({ message: "账号正在等待管理员审核" });
  if (user.status === "rejected") return res.status(403).json({ message: "账号注册申请未通过审核" });
  res.json({ token: signUser(user), user: publicUser(user) });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/characters", (req, res) => {
  const db = readDb();
  res.json({
    characters: db.characters
      .filter((character) => character.enabled)
      .map(({ prompt, apiKeyId, ...character }) => character)
  });
});

app.get("/api/sessions", requireUser, (req, res) => {
  const { characterId } = req.query;
  const db = readDb();
  res.json({ sessions: userSessions(db, req.user.id, characterId) });
});

app.post("/api/sessions", requireUser, (req, res) => {
  const db = readDb();
  const character = db.characters.find((item) => item.id === req.body.characterId && item.enabled);
  if (!character) return res.status(404).json({ message: "角色卡不存在或已停用" });

  const createdAt = now();
  const session = {
    id: uid("session"),
    userId: req.user.id,
    characterId: character.id,
    title: "新的聊天",
    createdAt,
    updatedAt: createdAt
  };
  db.sessions.push(session);

  if (character.useFirstMessage && character.firstMessage) {
    db.messages.push({
      id: uid("msg"),
      sessionId: session.id,
      userId: req.user.id,
      characterId: character.id,
      role: "assistant",
      content: character.firstMessage,
      createdAt
    });
  }

  writeDb(db);
  res.json({ session, messages: messagesForSession(db, session.id) });
});

app.get("/api/sessions/:id/messages", requireUser, (req, res) => {
  const db = readDb();
  const session = db.sessions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!session) return res.status(404).json({ message: "会话不存在" });
  res.json({ session, messages: messagesForSession(db, session.id) });
});

app.post("/api/chat/stream", requireUser, chatLimiter, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  return withUserChatLock(req.user.id, async () => {
  const { sessionId } = req.body;
  const message = sanitizeString(req.body.message, maxMessageChars);
  const attachments = normalizeAttachments(req.body.attachments, { maxFiles: maxAttachmentFiles, maxTextChars: maxAttachmentTextChars });
  if (!sessionId || (!message && !attachments.length)) {
    sendSse(res, "error", { message: "缺少会话或消息内容" });
    return res.end();
  }

  let db = readDb();
  const user = db.users.find((item) => item.id === req.user.id);
  const session = db.sessions.find((item) => item.id === sessionId && item.userId === req.user.id);
  if (!session) {
    sendSse(res, "error", { message: "会话不存在" });
    return res.end();
  }

  const character = db.characters.find((item) => item.id === session.characterId && item.enabled);
  if (!character) {
    sendSse(res, "error", { message: "角色卡不存在或已停用" });
    return res.end();
  }

  const price = character.usePrice ? Math.max(0, Number(character.price || 0)) : 0;
  if (Number(user.balance || 0) < price) {
    sendSse(res, "error", { message: "余额不足，请充值后继续对话" });
    return res.end();
  }

  const createdAt = now();
  const userMessage = {
    id: uid("msg"),
    sessionId: session.id,
    userId: user.id,
    characterId: character.id,
    role: "user",
    content: message,
    attachments,
    createdAt
  };
  db.messages.push(userMessage);
  session.updatedAt = createdAt;
  if (session.title === "新的聊天") session.title = message.slice(0, 28);
  writeDb(db);
  sendSse(res, "user-saved", { message: userMessage, session });

  db = readDb();
  const api = character.useApiKey
    ? db.apiKeys.find((item) => item.id === character.apiKeyId && item.enabled)
    : db.apiKeys.find((item) => item.id === "api_default" && item.enabled);
  const promptSettings = mergePromptSettings({
    ...db.promptSettings,
    maxHistoryMessages: db.promptSettings?.maxHistoryMessages || maxHistoryMessages
  });
  const clientContext = normalizeClientContext(req.body.clientContext || req.body, req.headers["user-agent"]);
  const instructions = buildInstructions({
    character,
    user,
    context: clientContext,
    promptSettings
  });
  const input = buildModelInput({
    messages: messagesForSession(db, session.id),
    promptSettings
  });
  const requestSnapshot = buildRequestSnapshot({
    instructions,
    input,
    context: clientContext,
    attachments,
    promptSettings,
    api,
    character,
    user
  });

  let assistantText = "";
  let usage = null;

  try {
    const apiKey = api?.apiKeySecret || process.env.OPENAI_API_KEY;
    if (apiKey && price <= 0 && !allowFreeAiCalls) {
      sendSse(res, "error", { message: "该角色卡尚未设置单次对话价格，已阻止真实模型调用以保护 API Key" });
      return res.end();
    }

    if (apiKey) await assertAdminCredentialSafety(db);

    if (!apiKey) {
      const demo = "当前后端还没有配置 OpenAI API Key。这条回复用于验证 SSE 流式输出、Markdown 渲染、历史记录保存和余额检测流程。\n\n```js\nconsole.log('ai-tavern 已连接');\n```";
      for (const chunk of demo.match(/.{1,12}/gs) || []) {
        assistantText += chunk;
        sendSse(res, "delta", { delta: chunk });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } else {
      const result = await streamOpenAIResponse({
        apiKey,
        apiUrl: validatePublicBaseUrl(api?.apiUrl || process.env.OPENAI_BASE_URL),
        model: api?.model || process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions,
        input,
        maxOutputTokens,
        promptSettings,
        onDelta: (delta) => {
          assistantText += delta;
          sendSse(res, "delta", { delta });
        }
      });
      usage = result.usage;
    }

    db = readDb();
    const freshUser = db.users.find((item) => item.id === user.id);
    const assistantMessage = {
      id: uid("msg"),
      sessionId: session.id,
      userId: user.id,
      characterId: character.id,
      role: "assistant",
      content: assistantText,
      attachments: [],
      requestSnapshot,
      usage,
      createdAt: now()
    };
    db.messages.push(assistantMessage);
    freshUser.balance = Math.max(0, Number(freshUser.balance || 0) - price);
    freshUser.updatedAt = now();
    db.billings.push({
      id: uid("bill"),
      userId: user.id,
      characterId: character.id,
      sessionId: session.id,
      messageId: assistantMessage.id,
      amount: price,
      createdAt: now()
    });
    const freshSession = db.sessions.find((item) => item.id === session.id);
    if (freshSession) freshSession.updatedAt = now();
    writeDb(db);
    sendSse(res, "done", { message: assistantMessage, balance: freshUser.balance });
    res.end();
  } catch (error) {
    console.error("AI response failed:", error);
    sendSse(res, "error", { message: error.code === "CHAT_IN_PROGRESS" ? error.message : "AI 回复失败，请稍后再试" });
    res.end();
  }
  }).catch((error) => {
    sendSse(res, "error", { message: error.message || "聊天请求失败" });
    res.end();
  });
});

app.post("/api/admin/auth/login", authLimiter, async (req, res) => {
  const username = sanitizeString(req.body.username, 80);
  const { password } = req.body;
  const db = readDb();
  const admin = db.admins.find((item) => item.username === username);
  if (!admin || !(await bcrypt.compare(password || "", admin.passwordHash))) {
    return res.status(401).json({ message: "管理员用户名或密码错误" });
  }
  res.json({ token: signAdmin(admin), admin: { id: admin.id, username: admin.username } });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const db = readDb();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] || 0), 0);

  res.json({
    stats: {
      users: db.users.length,
      pendingUsers: db.users.filter((user) => user.status === "pending").length,
      admins: db.admins.length,
      characters: db.characters.length,
      apiKeys: db.apiKeys.length,
      sessions: db.sessions.length,
      messages: db.messages.length,
      totalSpend: sum(db.billings, "amount"),
      todayUsers: db.users.filter((user) => new Date(user.createdAt).getTime() >= today).length,
      todayChats: db.messages.filter((message) => message.role === "user" && new Date(message.createdAt).getTime() >= today).length
    }
  });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const query = String(req.query.query || "").trim().toLowerCase();
  const db = readDb();
  const users = db.users
    .filter((user) => !query || user.id.toLowerCase().includes(query) || user.username.toLowerCase().includes(query) || user.email.toLowerCase().includes(query))
    .map(publicUser);
  res.json({ users });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  const { username, email, balance } = req.body;
  if (username !== undefined) user.username = sanitizeString(username, 40);
  if (email !== undefined) {
    const safeEmail = sanitizeString(email, 254).toLowerCase();
    if (!isValidEmail(safeEmail)) return res.status(400).json({ message: "邮箱格式不正确" });
    user.email = safeEmail;
  }
  if (balance !== undefined) {
    const safeBalance = Number(balance);
    if (!Number.isFinite(safeBalance) || safeBalance < 0) return res.status(400).json({ message: "余额必须是非负数字" });
    user.balance = safeBalance;
  }
  user.updatedAt = now();
  writeDb(db);
  res.json({ user: publicUser(user) });
});

app.post("/api/admin/users/:id/approve", requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  user.status = "active";
  user.approvedAt = now();
  user.approvedBy = req.admin.id;
  user.rejectedAt = null;
  user.rejectionReason = null;
  user.updatedAt = now();
  writeDb(db);
  res.json({ user: publicUser(user) });
});

app.post("/api/admin/users/:id/reject", requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  user.status = "rejected";
  user.rejectedAt = now();
  user.rejectionReason = sanitizeString(req.body.reason || "管理员拒绝注册申请", 300);
  user.updatedAt = now();
  writeDb(db);
  res.json({ user: publicUser(user) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const db = readDb();
  db.users = db.users.filter((item) => item.id !== req.params.id);
  const sessionIds = db.sessions.filter((item) => item.userId === req.params.id).map((item) => item.id);
  db.sessions = db.sessions.filter((item) => item.userId !== req.params.id);
  db.messages = db.messages.filter((item) => !sessionIds.includes(item.sessionId));
  db.billings = db.billings.filter((item) => item.userId !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/users/:id/history", requireAdmin, (req, res) => {
  const { characterId } = req.query;
  const db = readDb();
  const sessions = db.sessions
    .filter((session) => session.userId === req.params.id && (!characterId || session.characterId === characterId))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((session) => ({
      ...session,
      messages: messagesForSession(db, session.id)
    }));
  res.json({ sessions });
});

app.get("/api/admin/users/:id/history/:sessionId", requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });

  const session = db.sessions.find((item) => item.id === req.params.sessionId && item.userId === user.id);
  if (!session) return res.status(404).json({ message: "会话不存在" });

  const character = db.characters.find((item) => item.id === session.characterId);
  const api = db.apiKeys.find((item) => item.id === character?.apiKeyId);
  const messages = messagesForSession(db, session.id);
  const requestSnapshots = messages
    .filter((message) => message.requestSnapshot)
    .map((message) => ({
      messageId: message.id,
      createdAt: message.createdAt,
      snapshot: message.requestSnapshot
    }));
  const latestSnapshot = requestSnapshots.at(-1)?.snapshot || null;

  res.json({
    user: publicUser(user),
    session,
    character: character ? {
      id: character.id,
      name: character.name,
      prompt: character.prompt,
      firstMessage: character.firstMessage,
      price: character.price,
      usePrompt: character.usePrompt,
      useFirstMessage: character.useFirstMessage,
      useApiKey: character.useApiKey,
      usePrice: character.usePrice,
      enabled: character.enabled,
      isDefault: character.isDefault
    } : null,
    api: api ? publicApiKey(api) : null,
    systemContext: latestSnapshot?.context || null,
    systemPrompt: latestSnapshot?.instructions || "旧历史记录未保存当次完整系统提示词",
    requestSnapshots,
    messages
  });
});

app.get("/api/admin/prompt-settings", requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ settings: mergePromptSettings(db.promptSettings) });
});

app.patch("/api/admin/prompt-settings", requireAdmin, (req, res) => {
  const db = readDb();
  db.promptSettings = mergePromptSettings({
    systemTemplate: sanitizeString(req.body.systemTemplate ?? defaultPromptSettings.systemTemplate, 40000),
    historyStrategy: sanitizeString(req.body.historyStrategy ?? defaultPromptSettings.historyStrategy, 60),
    maxHistoryMessages: req.body.maxHistoryMessages,
    compressionThresholdMessages: req.body.compressionThresholdMessages,
    includeUserEnvironment: req.body.includeUserEnvironment !== false,
    includeAttachmentsInPrompt: req.body.includeAttachmentsInPrompt !== false,
    promptCacheRetention: sanitizeString(req.body.promptCacheRetention ?? defaultPromptSettings.promptCacheRetention, 20),
    updatedAt: now()
  });
  writeDb(db);
  res.json({ settings: mergePromptSettings(db.promptSettings) });
});

app.get("/api/admin/characters", requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ characters: db.characters });
});

app.post("/api/admin/characters", requireAdmin, (req, res) => {
  const db = readDb();
  const createdAt = now();
  const character = {
    id: uid("character"),
    name: sanitizeString(req.body.name, 80),
    prompt: sanitizeString(req.body.prompt, 20000),
    firstMessage: sanitizeString(req.body.firstMessage, 4000),
    apiKeyId: sanitizeString(req.body.apiKeyId, 120),
    price: Math.max(0, Number(req.body.price || 0)),
    usePrompt: req.body.usePrompt !== false,
    useFirstMessage: req.body.useFirstMessage !== false,
    useApiKey: Boolean(req.body.useApiKey && req.body.apiKeyId),
    usePrice: req.body.usePrice !== false,
    enabled: req.body.enabled !== false,
    isDefault: false,
    createdAt,
    updatedAt: createdAt
  };
  if (!character.name) return res.status(400).json({ message: "角色卡名称必填" });
  db.characters.push(character);
  writeDb(db);
  res.json({ character });
});

app.patch("/api/admin/characters/:id", requireAdmin, (req, res) => {
  const db = readDb();
  const character = db.characters.find((item) => item.id === req.params.id);
  if (!character) return res.status(404).json({ message: "角色卡不存在" });
  Object.assign(character, {
    name: req.body.name === undefined ? character.name : sanitizeString(req.body.name, 80),
    prompt: req.body.prompt === undefined ? character.prompt : sanitizeString(req.body.prompt, 20000),
    firstMessage: req.body.firstMessage === undefined ? character.firstMessage : sanitizeString(req.body.firstMessage, 4000),
    apiKeyId: req.body.apiKeyId === undefined ? character.apiKeyId : sanitizeString(req.body.apiKeyId, 120),
    price: req.body.price === undefined ? character.price : Math.max(0, Number(req.body.price || 0)),
    usePrompt: req.body.usePrompt ?? character.usePrompt,
    useFirstMessage: req.body.useFirstMessage ?? character.useFirstMessage,
    useApiKey: req.body.useApiKey ?? character.useApiKey,
    usePrice: req.body.usePrice ?? character.usePrice,
    enabled: req.body.enabled ?? character.enabled,
    updatedAt: now()
  });
  if (character.isDefault) character.name = "默认模型";
  writeDb(db);
  res.json({ character });
});

app.delete("/api/admin/characters/:id", requireAdmin, (req, res) => {
  const db = readDb();
  const character = db.characters.find((item) => item.id === req.params.id);
  if (!character) return res.status(404).json({ message: "角色卡不存在" });
  if (character.isDefault) return res.status(400).json({ message: "默认角色卡不允许删除" });
  db.characters = db.characters.filter((item) => item.id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/apis", requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ apiKeys: db.apiKeys.map(publicApiKey) });
});

app.post("/api/admin/apis", requireAdmin, async (req, res) => {
  try {
  const db = readDb();
  if (req.body.apiKeySecret) await assertAdminCredentialSafety(db);
  const createdAt = now();
  const apiKey = {
    id: uid("api"),
    name: sanitizeString(req.body.name, 80),
    model: sanitizeString(req.body.model || "gpt-5-mini", 100),
    apiUrl: validatePublicBaseUrl(req.body.apiUrl || "https://api.openai.com/v1"),
    apiKeySecret: sanitizeString(req.body.apiKeySecret, 1000),
    enabled: req.body.enabled !== false,
    createdAt,
    updatedAt: createdAt
  };
  if (!apiKey.name) return res.status(400).json({ message: "API Key 名称必填" });
  db.apiKeys.push(apiKey);
  writeDb(db);
  res.json({ apiKey: publicApiKey(apiKey) });
  } catch (error) {
    res.status(400).json({ message: error.message || "API 配置不合法" });
  }
});

app.patch("/api/admin/apis/:id", requireAdmin, async (req, res) => {
  try {
  const db = readDb();
  if (req.body.apiKeySecret) await assertAdminCredentialSafety(db);
  const apiKey = db.apiKeys.find((item) => item.id === req.params.id);
  if (!apiKey) return res.status(404).json({ message: "API Key 不存在" });
  apiKey.name = req.body.name === undefined ? apiKey.name : sanitizeString(req.body.name, 80);
  apiKey.model = req.body.model === undefined ? apiKey.model : sanitizeString(req.body.model, 100);
  apiKey.apiUrl = req.body.apiUrl === undefined ? apiKey.apiUrl : validatePublicBaseUrl(req.body.apiUrl);
  apiKey.enabled = req.body.enabled ?? apiKey.enabled;
  if (req.body.apiKeySecret) apiKey.apiKeySecret = sanitizeString(req.body.apiKeySecret, 1000);
  apiKey.updatedAt = now();
  writeDb(db);
  res.json({ apiKey: publicApiKey(apiKey) });
  } catch (error) {
    res.status(400).json({ message: error.message || "API 配置不合法" });
  }
});

app.delete("/api/admin/apis/:id", requireAdmin, (req, res) => {
  const db = readDb();
  const boundCharacters = db.characters.filter((item) => item.apiKeyId === req.params.id);
  if (boundCharacters.length && req.query.force !== "true") {
    return res.status(409).json({
      requiresConfirmation: true,
      message: "该 API Key 已被角色卡使用，删除后相关角色卡将无法正常调用模型，是否继续？",
      boundCharacters: boundCharacters.map((item) => item.name)
    });
  }
  db.apiKeys = db.apiKeys.filter((item) => item.id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/billing", requireAdmin, (req, res) => {
  const db = readDb();
  const byCharacter = db.characters.map((character) => {
    const bills = db.billings.filter((bill) => bill.characterId === character.id);
    return {
      characterId: character.id,
      characterName: character.name,
      calls: bills.length,
      amount: bills.reduce((total, bill) => total + Number(bill.amount || 0), 0)
    };
  });
  res.json({
    total: byCharacter.reduce((total, row) => total + row.amount, 0),
    byCharacter
  });
});

await seedDb();
await assertStoredApiKeysAreSafe();

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Unhandled API error:", error);
  res.status(500).json({ message: "服务器内部错误" });
});

app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);
});
