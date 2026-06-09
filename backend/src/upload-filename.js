const fallbackFileName = "未命名文件";

function maybeDecodeLatin1Utf8(value) {
  const raw = String(value || "");
  if (!raw) return raw;

  const decoded = Buffer.from(raw, "latin1").toString("utf8");
  if (decoded === raw || decoded.includes("\uFFFD")) return raw;

  const rawLooksLatin1Encoded = /[\u0080-\u00ff]/.test(raw);
  const decodedLooksUnicode = /[^\u0000-\u007f]/.test(decoded);
  return rawLooksLatin1Encoded && decodedLooksUnicode ? decoded : raw;
}

export function normalizeUploadFileName(value) {
  const decoded = maybeDecodeLatin1Utf8(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() || fallbackFileName;

  return decoded.normalize("NFC").slice(0, 180) || fallbackFileName;
}
