import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import multer from "multer";
import { parseAttachmentBuffer } from "./attachment-parser.js";
import {
  createSessionWithMessages,
  deleteApiKey,
  deleteCharacter,
  deleteUserCascade,
  emailExists,
  findApiForCharacter,
  getAdminByUsername,
  getAdminStats,
  getApiKeyById,
  getCharacterById,
  getEnabledCharacterById,
  getMessagesForPrompt,
  getMessagesForSession,
  getSessionForUser,
  getUserByEmail,
  getUserById,
  hasStoredApiKeySecret,
  insertApiKey,
  insertCharacter,
  insertUser,
  listAdmins,
  listApiKeys,
  listBillingByCharacter,
  listCharacters,
  listCharactersUsingApiKey,
  listEnabledPublicCharacters,
  listSessionsForUserCharacter,
  listUserHistorySessions,
  listUsers,
  publicApiKey,
  publicUser,
  readPromptSettingsForRuntime,
  saveAssistantChatResult,
  saveUserChatMessage,
  seedDb,
  setUserApproval,
  uid,
  now,
  updateApiKey,
  updateCharacter,
  updateUser,
  upsertPromptSettings
} from "./db.js";
import { requireUser, requireAdmin, signUser, signAdmin } from "./auth.js";
import { normalizeUploadFileName } from "./upload-filename.js";
import {
  buildInstructions,
  buildModelInput,
  buildRequestSnapshot,
  defaultPromptSettings,
  mergePromptSettings,
  normalizeAttachments,
  normalizeClientContext,
  normalizeReasoningEffort,
  summarizeAttachments,
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
  withAiResponseSlot,
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
const maxServerParseFileBytes = envNumber("MAX_SERVER_PARSE_FILE_BYTES", 5 * 1024 * 1024, { min: 1024, max: 5 * 1024 * 1024 });
const maxAttachmentImageDataUrlChars = envNumber("MAX_ATTACHMENT_IMAGE_DATA_URL_CHARS", 1600000, { min: 10000, max: 2500000 });
const maxConcurrentAiResponses = envNumber("MAX_CONCURRENT_AI_RESPONSES", 5, { min: 1, max: 100 });
const userInitialBalance = envNumber("USER_INITIAL_BALANCE", 0, { min: 0, max: 1000000 });
const allowFreeAiCalls = envBool("ALLOW_FREE_AI_CALLS", false);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxServerParseFileBytes,
    files: 1
  }
});

assertSafeStartup();
app.disable("x-powered-by");

function splitOrigins(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const allowedCorsOrigins = new Set([
  process.env.USER_FRONTEND_ORIGIN || "http://localhost:5173",
  process.env.ADMIN_FRONTEND_ORIGIN || "http://localhost:5174",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5183",
  "http://127.0.0.1:5183",
  "http://localhost:5184",
  "http://127.0.0.1:5184",
  ...splitOrigins(process.env.CORS_ORIGINS)
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedCorsOrigins.has(origin.replace(/\/+$/, ""))) return callback(null, true);
    return callback(new Error("CORS origin not allowed"));
  },
  credentials: true
}));
app.use(securityHeaders);
app.use(express.json({ limit: "12mb" }));
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
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendSseComment(res) {
  if (res.writableEnded || res.destroyed) return;
  res.write(":\n\n");
}

function endSse(res) {
  if (!res.writableEnded && !res.destroyed) res.end();
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
  const admins = db?.admins || listAdmins();
  for (const admin of admins) {
    for (const password of unsafePasswords) {
      if (await bcrypt.compare(password, admin.passwordHash)) {
        throw new Error("保存或使用真实 API Key 前必须修改默认管理员密码");
      }
    }
  }
}

async function assertStoredApiKeysAreSafe() {
  const hasStoredKey = hasStoredApiKeySecret() || Boolean(process.env.OPENAI_API_KEY);
  if (hasStoredKey) await assertAdminCredentialSafety();
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

  if (emailExists(email)) {
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
  insertUser(user);

  res.json({ pendingApproval: true, message: "注册申请已提交，请等待管理员审核" });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = sanitizeString(req.body.email, 254).toLowerCase();
  const { password } = req.body;
  const user = getUserByEmail(email);
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
  res.json({
    characters: listEnabledPublicCharacters()
      .map(({ prompt, apiKeyId, ...character }) => character)
  });
});

app.get("/api/sessions", requireUser, (req, res) => {
  const { characterId } = req.query;
  res.json({ sessions: listSessionsForUserCharacter(req.user.id, characterId) });
});

app.post("/api/sessions", requireUser, (req, res) => {
  const character = getEnabledCharacterById(req.body.characterId);
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
  const messages = [];

  if (character.useFirstMessage && character.firstMessage) {
    messages.push({
      id: uid("msg"),
      sessionId: session.id,
      userId: req.user.id,
      characterId: character.id,
      role: "assistant",
      content: character.firstMessage,
      createdAt
    });
  }

  createSessionWithMessages(session, messages);
  res.json({ session, messages: getMessagesForSession(session.id) });
});

app.get("/api/sessions/:id/messages", requireUser, (req, res) => {
  const session = getSessionForUser(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ message: "会话不存在" });
  res.json({ session, messages: getMessagesForSession(session.id) });
});

app.post("/api/attachments/parse", requireUser, (req, res) => {
  upload.single("file")(req, res, async (error) => {
    if (error) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        message: tooLarge ? "需要服务器解析的文件必须小于 5MB" : "文件上传失败"
      });
    }

    if (!req.file) return res.status(400).json({ message: "缺少文件" });

    try {
      const fileName = normalizeUploadFileName(req.file.originalname);
      const parsed = await parseAttachmentBuffer(req.file, { maxTextChars: maxAttachmentTextChars });
      return res.json({
        attachment: {
          name: fileName,
          type: String(req.file.mimetype || parsed.type || "application/octet-stream").slice(0, 120),
          size: req.file.size,
          kind: parsed.kind,
          text: parsed.text,
          hasText: Boolean(parsed.text),
          source: "server",
          truncated: parsed.truncated
        }
      });
    } catch (parseError) {
      return res.status(parseError.statusCode || 422).json({
        message: parseError.statusCode === 415 ? parseError.message : "文件解析失败，请转换为 PDF、DOCX、XLSX、CSV 或文本后重试"
      });
    }
  });
});

app.post("/api/chat/stream", requireUser, chatLimiter, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const abortController = new AbortController();
  res.on("close", () => abortController.abort());

  return withUserChatLock(req.user.id, async () => {
  const { sessionId } = req.body;
  const message = sanitizeString(req.body.message, maxMessageChars);
  const attachmentsForModel = normalizeAttachments(req.body.attachments, {
    maxFiles: maxAttachmentFiles,
    maxTextChars: maxAttachmentTextChars,
    maxImageDataUrlChars: maxAttachmentImageDataUrlChars
  });
  const attachments = summarizeAttachments(attachmentsForModel);
  if (!sessionId || (!message && !attachments.length)) {
    sendSse(res, "error", { message: "缺少会话或消息内容" });
    return endSse(res);
  }

  const user = getUserById(req.user.id);
  const session = getSessionForUser(sessionId, req.user.id);
  if (!session) {
    sendSse(res, "error", { message: "会话不存在" });
    return endSse(res);
  }

  const character = getEnabledCharacterById(session.characterId);
  if (!character) {
    sendSse(res, "error", { message: "角色卡不存在或已停用" });
    return endSse(res);
  }

  const price = character.usePrice ? Math.max(0, Number(character.price || 0)) : 0;
  if (Number(user.balance || 0) < price) {
    sendSse(res, "error", { message: "余额不足，请充值后继续对话" });
    return endSse(res);
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
  const updatedSession = saveUserChatMessage(userMessage, message.slice(0, 28));
  sendSse(res, "user-saved", { message: userMessage, session: updatedSession || session });

  const api = findApiForCharacter(character);
  const storedPromptSettings = readPromptSettingsForRuntime();
  const promptSettings = mergePromptSettings({
    ...storedPromptSettings,
    maxHistoryMessages: storedPromptSettings?.maxHistoryMessages || maxHistoryMessages
  });
  const clientContext = normalizeClientContext(req.body.clientContext || req.body, req.headers["user-agent"]);
  const instructions = buildInstructions({
    character,
    user,
    context: clientContext,
    promptSettings
  });
  const input = buildModelInput({
    messages: [
      ...getMessagesForPrompt(session.id, promptSettings).filter((item) => item.id !== userMessage.id),
      { ...userMessage, attachments: attachmentsForModel }
    ],
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
  let assistantThinking = "";
  const streamStartedAt = Date.now();
  let thinkingStartedAt = null;
  let thinkingDurationMs = null;
  let usage = null;
  let queueHeartbeat = null;
  const stopQueueHeartbeat = () => {
    if (queueHeartbeat) {
      clearInterval(queueHeartbeat);
      queueHeartbeat = null;
    }
  };
  const noteThinkingStarted = () => {
    if (!thinkingStartedAt) thinkingStartedAt = Date.now();
  };
  const finishThinking = () => {
    if (thinkingDurationMs !== null) return thinkingDurationMs;
    const startedAt = thinkingStartedAt || streamStartedAt;
    thinkingDurationMs = Math.max(0, Date.now() - startedAt);
    sendSse(res, "thinking-done", { elapsedMs: thinkingDurationMs });
    return thinkingDurationMs;
  };

  try {
    const apiKey = api?.apiKeySecret || process.env.OPENAI_API_KEY;
    if (apiKey && price <= 0 && !allowFreeAiCalls) {
      sendSse(res, "error", { message: "该角色卡尚未设置单次对话价格，已阻止真实模型调用以保护 API Key" });
      return endSse(res);
    }

    if (apiKey) await assertAdminCredentialSafety();

    await withAiResponseSlot({
      limit: maxConcurrentAiResponses,
      signal: abortController.signal,
      onQueued: () => {
        sendSseComment(res);
        queueHeartbeat = setInterval(() => sendSseComment(res), 15_000);
      },
      onDequeued: stopQueueHeartbeat
    }, async () => {
      if (!apiKey) {
        const demoThinking = [
          "已接收当前会话和附件元数据。",
          "正在验证流式输出、Markdown 渲染和历史记录保存路径。",
          "准备返回一段本地占位回复用于前端验收。"
        ].join("\n");
        for (const chunk of demoThinking.match(/.{1,14}/gs) || []) {
          if (abortController.signal.aborted) throw Object.assign(new Error("请求已取消"), { code: "REQUEST_ABORTED" });
          noteThinkingStarted();
          assistantThinking += chunk;
          sendSse(res, "thinking", { delta: chunk });
          await new Promise((resolve) => setTimeout(resolve, 24));
        }
        finishThinking();
        const demo = "当前后端还没有配置 OpenAI API Key。这条回复用于验证 SSE 流式输出、Markdown 渲染、历史记录保存和余额检测流程。\n\n```js\nconsole.log('ai-tavern 已连接');\n```";
        for (const chunk of demo.match(/.{1,12}/gs) || []) {
          if (abortController.signal.aborted) throw Object.assign(new Error("请求已取消"), { code: "REQUEST_ABORTED" });
          assistantText += chunk;
          sendSse(res, "delta", { delta: chunk });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } else {
        const result = await streamOpenAIResponse({
          apiKey,
          apiUrl: validatePublicBaseUrl(api?.apiUrl || process.env.OPENAI_BASE_URL),
          model: api?.model || process.env.OPENAI_MODEL || "gpt-5-mini",
          reasoningEffort: api?.reasoningEffort || process.env.OPENAI_REASONING_EFFORT,
          instructions,
          input,
          maxOutputTokens,
          promptSettings,
          signal: abortController.signal,
          onThinkingDelta: (delta) => {
            noteThinkingStarted();
            assistantThinking += delta;
            sendSse(res, "thinking", { delta });
          },
          onDelta: (delta) => {
            if (assistantThinking && thinkingDurationMs === null) finishThinking();
            assistantText += delta;
            sendSse(res, "delta", { delta });
          }
        });
        usage = result.usage;
      }
    });

    const assistantMessage = {
      id: uid("msg"),
      sessionId: session.id,
      userId: user.id,
      characterId: character.id,
      role: "assistant",
      content: assistantText,
      thinking: assistantThinking,
      thinkingDurationMs: assistantThinking ? (thinkingDurationMs ?? Math.max(0, Date.now() - (thinkingStartedAt || streamStartedAt))) : null,
      attachments: [],
      requestSnapshot,
      usage,
      createdAt: now()
    };
    const billing = {
      id: uid("bill"),
      userId: user.id,
      characterId: character.id,
      sessionId: session.id,
      messageId: assistantMessage.id,
      amount: price,
      createdAt: now()
    };
    const saved = saveAssistantChatResult({
      assistantMessage,
      userId: user.id,
      sessionId: session.id,
      amount: price,
      billing
    });
    sendSse(res, "done", { message: assistantMessage, balance: saved.balance });
    endSse(res);
  } catch (error) {
    stopQueueHeartbeat();
    if (error.code === "REQUEST_ABORTED") return endSse(res);
    console.error("AI response failed:", error);
    sendSse(res, "error", { message: error.code === "CHAT_IN_PROGRESS" ? error.message : "AI 回复失败，请稍后再试" });
    endSse(res);
  }
  }).catch((error) => {
    sendSse(res, "error", { message: error.message || "聊天请求失败" });
    endSse(res);
  });
});

app.post("/api/admin/auth/login", authLimiter, async (req, res) => {
  const username = sanitizeString(req.body.username, 80);
  const { password } = req.body;
  const admin = getAdminByUsername(username);
  if (!admin || !(await bcrypt.compare(password || "", admin.passwordHash))) {
    return res.status(401).json({ message: "管理员用户名或密码错误" });
  }
  res.json({ token: signAdmin(admin), admin: { id: admin.id, username: admin.username } });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  res.json({ stats: getAdminStats(startOfToday.toISOString()) });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ users: listUsers(req.query.query).map(publicUser) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const { username, email, balance } = req.body;
  const patch = {};
  if (username !== undefined) patch.username = sanitizeString(username, 40);
  if (email !== undefined) {
    const safeEmail = sanitizeString(email, 254).toLowerCase();
    if (!isValidEmail(safeEmail)) return res.status(400).json({ message: "邮箱格式不正确" });
    patch.email = safeEmail;
  }
  if (balance !== undefined) {
    const safeBalance = Number(balance);
    if (!Number.isFinite(safeBalance) || safeBalance < 0) return res.status(400).json({ message: "余额必须是非负数字" });
    patch.balance = safeBalance;
  }
  const user = updateUser(req.params.id, patch);
  if (!user) return res.status(404).json({ message: "用户不存在" });
  res.json({ user: publicUser(user) });
});

app.post("/api/admin/users/:id/approve", requireAdmin, (req, res) => {
  const user = setUserApproval(req.params.id, {
    status: "active",
    approvedAt: now(),
    approvedBy: req.admin.id,
    rejectedAt: null,
    rejectionReason: null
  });
  if (!user) return res.status(404).json({ message: "用户不存在" });
  res.json({ user: publicUser(user) });
});

app.post("/api/admin/users/:id/reject", requireAdmin, (req, res) => {
  const user = setUserApproval(req.params.id, {
    status: "rejected",
    approvedAt: null,
    approvedBy: null,
    rejectedAt: now(),
    rejectionReason: sanitizeString(req.body.reason || "管理员拒绝注册申请", 300)
  });
  if (!user) return res.status(404).json({ message: "用户不存在" });
  res.json({ user: publicUser(user) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  res.json({ ok: deleteUserCascade(req.params.id) });
});

app.get("/api/admin/users/:id/history", requireAdmin, (req, res) => {
  const { characterId } = req.query;
  res.json({ sessions: listUserHistorySessions(req.params.id, characterId) });
});

app.get("/api/admin/users/:id/history/:sessionId", requireAdmin, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ message: "用户不存在" });

  const session = getSessionForUser(req.params.sessionId, user.id);
  if (!session) return res.status(404).json({ message: "会话不存在" });

  const character = getCharacterById(session.characterId);
  const api = getApiKeyById(character?.apiKeyId);
  const messages = getMessagesForSession(session.id, { includeRequestSnapshot: true });
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
  res.json({ settings: mergePromptSettings(readPromptSettingsForRuntime()) });
});

app.patch("/api/admin/prompt-settings", requireAdmin, (req, res) => {
  const settings = mergePromptSettings({
    systemTemplate: sanitizeString(req.body.systemTemplate ?? defaultPromptSettings.systemTemplate, 40000),
    historyStrategy: sanitizeString(req.body.historyStrategy ?? defaultPromptSettings.historyStrategy, 60),
    maxHistoryMessages: req.body.maxHistoryMessages,
    compressionThresholdMessages: req.body.compressionThresholdMessages,
    includeUserEnvironment: req.body.includeUserEnvironment !== false,
    includeAttachmentsInPrompt: req.body.includeAttachmentsInPrompt !== false,
    promptCacheRetention: sanitizeString(req.body.promptCacheRetention ?? defaultPromptSettings.promptCacheRetention, 20),
    updatedAt: now()
  });
  res.json({ settings: mergePromptSettings(upsertPromptSettings(settings)) });
});

app.get("/api/admin/characters", requireAdmin, (req, res) => {
  res.json({ characters: listCharacters() });
});

app.post("/api/admin/characters", requireAdmin, (req, res) => {
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
  insertCharacter(character);
  res.json({ character });
});

app.patch("/api/admin/characters/:id", requireAdmin, (req, res) => {
  const current = getCharacterById(req.params.id);
  if (!current) return res.status(404).json({ message: "角色卡不存在" });
  const character = updateCharacter(req.params.id, {
    name: req.body.name === undefined ? current.name : sanitizeString(req.body.name, 80),
    prompt: req.body.prompt === undefined ? current.prompt : sanitizeString(req.body.prompt, 20000),
    firstMessage: req.body.firstMessage === undefined ? current.firstMessage : sanitizeString(req.body.firstMessage, 4000),
    apiKeyId: req.body.apiKeyId === undefined ? current.apiKeyId : sanitizeString(req.body.apiKeyId, 120),
    price: req.body.price === undefined ? current.price : Math.max(0, Number(req.body.price || 0)),
    usePrompt: req.body.usePrompt ?? current.usePrompt,
    useFirstMessage: req.body.useFirstMessage ?? current.useFirstMessage,
    useApiKey: req.body.useApiKey ?? current.useApiKey,
    usePrice: req.body.usePrice ?? current.usePrice,
    enabled: req.body.enabled ?? current.enabled
  });
  if (!character) return res.status(404).json({ message: "角色卡不存在" });
  res.json({ character });
});

app.delete("/api/admin/characters/:id", requireAdmin, (req, res) => {
  const character = getCharacterById(req.params.id);
  if (!character) return res.status(404).json({ message: "角色卡不存在" });
  if (character.isDefault) return res.status(400).json({ message: "默认角色卡不允许删除" });
  res.json({ ok: deleteCharacter(req.params.id) });
});

app.get("/api/admin/apis", requireAdmin, (req, res) => {
  res.json({ apiKeys: listApiKeys().map(publicApiKey) });
});

app.post("/api/admin/apis", requireAdmin, async (req, res) => {
  try {
  if (req.body.apiKeySecret) await assertAdminCredentialSafety();
  const createdAt = now();
  const apiKey = {
    id: uid("api"),
    name: sanitizeString(req.body.name, 80),
    model: sanitizeString(req.body.model || "gpt-5-mini", 100),
    apiUrl: validatePublicBaseUrl(req.body.apiUrl || "https://api.openai.com/v1"),
    apiKeySecret: sanitizeString(req.body.apiKeySecret, 1000),
    reasoningEffort: normalizeReasoningEffort(req.body.reasoningEffort),
    enabled: req.body.enabled !== false,
    createdAt,
    updatedAt: createdAt
  };
  if (!apiKey.name) return res.status(400).json({ message: "API Key 名称必填" });
  insertApiKey(apiKey);
  res.json({ apiKey: publicApiKey(apiKey) });
  } catch (error) {
    res.status(400).json({ message: error.message || "API 配置不合法" });
  }
});

app.patch("/api/admin/apis/:id", requireAdmin, async (req, res) => {
  try {
  if (req.body.apiKeySecret) await assertAdminCredentialSafety();
  const current = getApiKeyById(req.params.id);
  if (!current) return res.status(404).json({ message: "API Key 不存在" });
  const apiKey = updateApiKey(req.params.id, {
    name: req.body.name === undefined ? current.name : sanitizeString(req.body.name, 80),
    model: req.body.model === undefined ? current.model : sanitizeString(req.body.model, 100),
    apiUrl: req.body.apiUrl === undefined ? current.apiUrl : validatePublicBaseUrl(req.body.apiUrl),
    reasoningEffort: req.body.reasoningEffort === undefined ? current.reasoningEffort || "" : normalizeReasoningEffort(req.body.reasoningEffort),
    enabled: req.body.enabled ?? current.enabled,
    ...(req.body.apiKeySecret ? { apiKeySecret: sanitizeString(req.body.apiKeySecret, 1000) } : {})
  });
  if (!apiKey) return res.status(404).json({ message: "API Key 不存在" });
  res.json({ apiKey: publicApiKey(apiKey) });
  } catch (error) {
    res.status(400).json({ message: error.message || "API 配置不合法" });
  }
});

app.delete("/api/admin/apis/:id", requireAdmin, (req, res) => {
  const boundCharacters = listCharactersUsingApiKey(req.params.id);
  if (boundCharacters.length && req.query.force !== "true") {
    return res.status(409).json({
      requiresConfirmation: true,
      message: "该 API Key 已被角色卡使用，删除后相关角色卡将无法正常调用模型，是否继续？",
      boundCharacters: boundCharacters.map((item) => item.name)
    });
  }
  res.json({ ok: deleteApiKey(req.params.id) });
});

app.get("/api/admin/billing", requireAdmin, (req, res) => {
  const byCharacter = listBillingByCharacter();
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
