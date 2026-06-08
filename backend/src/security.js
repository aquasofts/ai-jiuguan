const windows = new Map();
const activeChats = new Set();

export function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function envNumber(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
}

export function makeRateLimiter({ windowMs, max, key = (req) => req.ip, message = "请求过于频繁，请稍后再试" }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = key(req);
    const hits = (windows.get(bucketKey) || []).filter((time) => now - time < windowMs);
    hits.push(now);
    windows.set(bucketKey, hits);

    if (hits.length > max) {
      return res.status(429).json({ message });
    }

    next();
  };
}

export function sanitizeString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

export function isStrongEnoughPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

export function validatePublicBaseUrl(apiUrl) {
  const raw = sanitizeString(apiUrl || "https://api.openai.com/v1", 300);
  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API 地址格式不正确");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("API 地址必须使用 http 或 https");
  }

  return raw.replace(/\/+$/, "");
}

export async function withUserChatLock(userId, action) {
  if (activeChats.has(userId)) {
    throw Object.assign(new Error("已有一条回复正在生成，请等待完成后再发送"), { code: "CHAT_IN_PROGRESS" });
  }

  activeChats.add(userId);
  try {
    return await action();
  } finally {
    activeChats.delete(userId);
  }
}

export function assertSafeStartup() {
  const isPublicHost = !["127.0.0.1", "localhost", "::1"].includes(process.env.HOST || "127.0.0.1");
  const insecureDefaultsAllowed = envBool("ALLOW_INSECURE_DEFAULTS", false);
  const jwtSecret = process.env.JWT_SECRET || "";
  const adminPassword = process.env.ADMIN_PASSWORD || "";

  if (!insecureDefaultsAllowed && isPublicHost) {
    if (!jwtSecret || jwtSecret === "replace-with-a-long-random-string" || jwtSecret === "dev-secret-change-me" || jwtSecret.length < 32) {
      throw new Error("公网监听前必须设置长度至少 32 位的 JWT_SECRET，或仅在本地使用 HOST=127.0.0.1");
    }

    if (!adminPassword || adminPassword === "admin123" || adminPassword.length < 12) {
      throw new Error("公网监听前必须设置强管理员密码 ADMIN_PASSWORD，不能使用默认 admin123");
    }
  }
}
