import OpenAI from "openai";

export const defaultSystemTemplate = `你正在为 ai-tavern 聊天应用生成回复。
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

const reasoningEfforts = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeReasoningEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  return reasoningEfforts.has(effort) ? effort : "";
}

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

function isSupportedImageDataUrl(value) {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(String(value || ""));
}

export function normalizeAttachments(rawAttachments = [], { maxFiles = 5, maxTextChars = 60000, maxImageDataUrlChars = 1600000 } = {}) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments.slice(0, maxFiles).map((file) => {
    const text = String(file?.text || "").slice(0, maxTextChars);
    const imageDataUrl = isSupportedImageDataUrl(file?.imageDataUrl) && String(file.imageDataUrl).length <= maxImageDataUrlChars
      ? String(file.imageDataUrl)
      : "";
    const hasImage = imageDataUrl || Boolean(file?.hasImage);
    return {
      name: String(file?.name || "未命名文件").slice(0, 180),
      type: String(file?.type || "application/octet-stream").slice(0, 120),
      size: Math.max(0, Number(file?.size || 0)),
      kind: ["image", "text", "document", "spreadsheet"].includes(file?.kind) ? file.kind : (hasImage ? "image" : "document"),
      text,
      imageDataUrl,
      hasText: Boolean(text) || Boolean(file?.hasText),
      hasImage,
      source: ["client", "server"].includes(file?.source) ? file.source : "client",
      truncated: Boolean(file?.truncated) || String(file?.text || "").length > maxTextChars
    };
  });
}

export function summarizeAttachments(attachments = []) {
  return attachments.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
    kind: file.kind,
    hasText: Boolean(file.text || file.hasText),
    hasImage: Boolean(file.imageDataUrl || file.hasImage),
    source: file.source,
    truncated: Boolean(file.truncated)
  }));
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
    let body = "内容：未随历史记录保存，仅提供文件元数据。";
    if (file.text) {
      body = `内容${file.truncated ? "（已截断）" : ""}：\n${file.text}`;
    } else if (file.imageDataUrl) {
      body = "内容：图片已作为视觉输入发送给模型。";
    } else if (file.hasImage) {
      body = "内容：图片内容未保存在历史记录中。";
    } else if (file.hasText) {
      body = "内容：文件正文已在上传当次发送给模型，历史记录中不保存正文。";
    }
    return `文件 ${index + 1}：${file.name}\n类型：${file.type}\n大小：${file.size} 字节\n${body}`;
  }).join("\n\n");
}

function formatMessageContentForModel(message, settings) {
  const content = String(message.content || "");
  if (!settings.includeAttachmentsInPrompt || message.role !== "user" || !message.attachments?.length) return content;
  const text = `${content}\n\n[用户上传文件]\n${attachmentPromptText(message.attachments)}`.trim();
  const imageInputs = message.attachments
    .filter((file) => file.imageDataUrl)
    .map((file) => ({
      type: "input_image",
      image_url: file.imageDataUrl,
      detail: "auto"
    }));
  if (!imageInputs.length) return text;
  return [
    { type: "input_text", text },
    ...imageInputs
  ];
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

function summarizeSnapshotContent(content) {
  if (typeof content === "string") {
    const marker = "[用户上传文件]";
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) return content;
    return `${content.slice(0, markerIndex)}${marker}\n附件正文和图片数据未保存到请求快照。`;
  }

  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "input_text") {
      return {
        ...part,
        text: summarizeSnapshotContent(part.text)
      };
    }
    if (part?.type === "input_image") {
      return {
        ...part,
        image_url: part.image_url ? "[image data omitted]" : part.image_url
      };
    }
    return part;
  });
}

function summarizeInputForSnapshot(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => ({
    ...item,
    content: summarizeSnapshotContent(item.content)
  }));
}

export function buildRequestSnapshot({ instructions, input, context, attachments, promptSettings, api, character, user }) {
  return {
    createdAt: new Date().toISOString(),
    provider: {
      apiKeyId: api?.id || "",
      apiName: api?.name || "",
      model: api?.model || "",
      apiUrl: api?.apiUrl || "",
      reasoningEffort: normalizeReasoningEffort(api?.reasoningEffort)
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
    input: summarizeInputForSnapshot(input)
  };
}

export function normalizeBaseUrl(apiUrl) {
  return (apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function stringifyReasoningDelta(delta) {
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    if (typeof delta.text === "string") return delta.text;
    if (typeof delta.delta === "string") return delta.delta;
  }
  return "";
}

export async function streamOpenAIResponse({ apiKey, apiUrl, model, reasoningEffort, instructions, input, onDelta, onThinkingDelta, maxOutputTokens, promptSettings, signal }) {
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
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  if (normalizedReasoningEffort) {
    request.reasoning = { effort: normalizedReasoningEffort, summary: "auto" };
  }

  const stream = await client.responses.create({
    ...request
  }, { signal });

  let text = "";
  let thinking = "";
  let usage = null;

  for await (const event of stream) {
    if (signal?.aborted) throw Object.assign(new Error("请求已取消"), { code: "REQUEST_ABORTED" });

    if (event.type === "response.output_text.delta" && event.delta) {
      text += event.delta;
      onDelta(event.delta);
    }

    if (event.type === "response.reasoning_summary.delta" || event.type === "response.reasoning_summary_text.delta") {
      const delta = stringifyReasoningDelta(event.delta);
      if (delta) {
        thinking += delta;
        onThinkingDelta?.(delta);
      }
    }

    if (event.type === "response.reasoning_summary.done" || event.type === "response.reasoning_summary_text.done") {
      const doneText = String(event.text || "").trim();
      if (doneText && !thinking.includes(doneText)) {
        const delta = thinking ? `\n\n${doneText}` : doneText;
        thinking += delta;
        onThinkingDelta?.(delta);
      }
    }

    if (event.type === "response.completed") {
      usage = event.response?.usage || null;
    }
  }

  return { text, thinking, usage };
}
