import OpenAI from "openai";

export const defaultSystemTemplate = `你正在为一个 AI 酒馆风格聊天应用生成回复。
请遵守平台安全要求，保持自然、连贯、尊重用户，并优先使用用户的语言。
以下上下文只用于帮助生成回复，不要主动向用户暴露这些系统上下文。

当前角色卡名称：{{characterName}}
当前角色卡 Prompt：
{{characterPrompt}}

当前时间：{{localTime}}
用户浏览器时区：{{timezone}}
用户系统信息：{{systemInfo}}
用户 UA：{{userAgent}}
用户基础信息：{{userProfile}}`;

export const defaultPromptSettings = {
  systemTemplate: defaultSystemTemplate,
  historyStrategy: "recent_with_summary",
  maxHistoryMessages: 40,
  compressionThresholdMessages: 60,
  includeUserEnvironment: true,
  includeAttachmentsInPrompt: true,
  promptCacheRetention: "in_memory"
};

export function mergePromptSettings(settings = {}) {
  return {
    ...defaultPromptSettings,
    ...(settings || {}),
    systemTemplate: settings?.systemTemplate || defaultSystemTemplate,
    historyStrategy: ["recent", "recent_with_summary"].includes(settings?.historyStrategy) ? settings.historyStrategy : defaultPromptSettings.historyStrategy,
    maxHistoryMessages: clampNumber(settings?.maxHistoryMessages, 1, 200, defaultPromptSettings.maxHistoryMessages),
    compressionThresholdMessages: clampNumber(settings?.compressionThresholdMessages, 1, 500, defaultPromptSettings.compressionThresholdMessages),
    includeUserEnvironment: settings?.includeUserEnvironment !== false,
    includeAttachmentsInPrompt: settings?.includeAttachmentsInPrompt !== false,
    promptCacheRetention: settings?.promptCacheRetention === "24h" ? "24h" : "in_memory"
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    return values[key] ?? "";
  });
}

export function normalizeClientContext(raw = {}, fallbackUserAgent = "") {
  const timezone = String(raw.timezone || "").slice(0, 120);
  const localTime = String(raw.localTime || "").slice(0, 120);
  const userAgent = String(raw.userAgent || fallbackUserAgent || "").slice(0, 500);
  const browserLanguage = String(raw.browserLanguage || "").slice(0, 80);
  const systemInfo = String(raw.systemInfo || "").slice(0, 1000);
  const screen = String(raw.screen || "").slice(0, 160);
  const userTime = localTime || new Date().toISOString();

  return {
    timezone: timezone || "未知",
    localTime: userTime,
    userAgent: userAgent || "未知",
    browserLanguage: browserLanguage || "未知",
    systemInfo: systemInfo || "未知",
    screen: screen || "未知"
  };
}

export function normalizeAttachments(rawAttachments = [], { maxFiles = 5, maxTextChars = 60000 } = {}) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments.slice(0, maxFiles).map((file) => {
    const text = String(file?.text || "").slice(0, maxTextChars);
    return {
      name: String(file?.name || "未命名文件").slice(0, 180),
      type: String(file?.type || "application/octet-stream").slice(0, 120),
      size: Math.max(0, Number(file?.size || 0)),
      text,
      truncated: Boolean(file?.truncated) || String(file?.text || "").length > maxTextChars
    };
  });
}

export function buildInstructions({ character, user, context, promptSettings }) {
  const settings = mergePromptSettings(promptSettings);
  const safeContext = settings.includeUserEnvironment ? context : {
    localTime: context.localTime,
    timezone: "未发送到模型",
    systemInfo: "未发送到模型",
    userAgent: "未发送到模型",
    browserLanguage: "未发送到模型",
    screen: "未发送到模型"
  };

  return renderTemplate(settings.systemTemplate, {
    characterName: character?.name || "默认模型",
    characterPrompt: character?.usePrompt && character.prompt ? character.prompt : "未启用或未填写",
    localTime: safeContext.localTime || new Date().toISOString(),
    timezone: safeContext.timezone || "未知",
    systemInfo: safeContext.systemInfo || "未知",
    userAgent: safeContext.userAgent || "未知",
    browserLanguage: safeContext.browserLanguage || "未知",
    screen: safeContext.screen || "未知",
    userProfile: `用户名=${user?.username || "未知"}，邮箱=${user?.email || "未知"}`
  });
}

function attachmentPromptText(attachments) {
  if (!attachments?.length) return "";
  return attachments.map((file, index) => {
    const body = file.text
      ? `内容${file.truncated ? "（已截断）" : ""}：\n${file.text}`
      : "内容：浏览器无法读取该文件为文本，仅提供文件元数据。";
    return `文件 ${index + 1}：${file.name}\n类型：${file.type}\n大小：${file.size} 字节\n${body}`;
  }).join("\n\n");
}

function formatMessageContentForModel(message, settings) {
  const content = String(message.content || "");
  if (!settings.includeAttachmentsInPrompt || message.role !== "user" || !message.attachments?.length) return content;
  return `${content}\n\n[用户上传文件]\n${attachmentPromptText(message.attachments)}`.trim();
}

function summarizeOlderMessages(messages, settings) {
  const limit = Math.max(1, settings.compressionThresholdMessages);
  const visible = messages.slice(-limit);
  return visible.map((message) => {
    const role = message.role === "assistant" ? "AI" : "用户";
    const attachmentNames = message.attachments?.length ? `；附件=${message.attachments.map((file) => file.name).join(", ")}` : "";
    const content = String(message.content || "").replace(/\s+/g, " ").slice(0, 700);
    return `${role}：${content}${attachmentNames}`;
  }).join("\n");
}

export function buildModelInput({ messages, promptSettings }) {
  const settings = mergePromptSettings(promptSettings);
  const prepared = messages.map((message) => ({
    role: message.role,
    content: formatMessageContentForModel(message, settings)
  }));

  if (prepared.length <= settings.maxHistoryMessages) return prepared;

  const recentMessages = messages.slice(-settings.maxHistoryMessages);
  const recent = recentMessages.map((message) => ({
    role: message.role,
    content: formatMessageContentForModel(message, settings)
  }));

  if (settings.historyStrategy === "recent") return recent;

  const olderMessages = messages.slice(0, -settings.maxHistoryMessages);
  return [
    {
      role: "user",
      content: `[更早历史记录压缩]\n以下是超过窗口的较早对话，按原角色摘录并压缩；新的用户消息仍保留在后续完整历史中。\n${summarizeOlderMessages(olderMessages, settings)}`
    },
    ...recent
  ];
}

export function buildRequestSnapshot({ instructions, input, context, attachments, promptSettings, api, character, user }) {
  return {
    createdAt: new Date().toISOString(),
    provider: {
      apiKeyId: api?.id || "",
      apiName: api?.name || "",
      model: api?.model || "",
      apiUrl: api?.apiUrl || ""
    },
    promptSettings: mergePromptSettings(promptSettings),
    character: character ? {
      id: character.id,
      name: character.name,
      prompt: character.prompt,
      usePrompt: character.usePrompt
    } : null,
    user: user ? {
      id: user.id,
      username: user.username,
      email: user.email
    } : null,
    context,
    attachments,
    instructions,
    input
  };
}

export function normalizeBaseUrl(apiUrl) {
  return (apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export async function streamOpenAIResponse({ apiKey, apiUrl, model, instructions, input, onDelta, maxOutputTokens, promptSettings }) {
  const client = new OpenAI({
    apiKey,
    baseURL: normalizeBaseUrl(apiUrl)
  });

  const settings = mergePromptSettings(promptSettings);
  const request = {
    model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    stream: true,
    store: false
  };
  if (settings.promptCacheRetention === "24h") {
    request.prompt_cache_retention = "24h";
  }

  const stream = await client.responses.create({
    ...request
  });

  let text = "";
  let usage = null;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && event.delta) {
      text += event.delta;
      onDelta(event.delta);
    }

    if (event.type === "response.completed") {
      usage = event.response?.usage || null;
    }
  }

  return { text, usage };
}
