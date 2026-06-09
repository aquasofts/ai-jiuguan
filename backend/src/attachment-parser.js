import path from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import readExcelFile from "read-excel-file/node";
import { normalizeUploadFileName } from "./upload-filename.js";

const serverParseableExtensions = new Set([".pdf", ".docx", ".xlsx"]);

function fileExtension(fileName = "") {
  return path.extname(String(fileName).toLowerCase());
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function limitText(text, maxTextChars) {
  const normalized = normalizeWhitespace(text);
  return {
    text: normalized.slice(0, maxTextChars),
    truncated: normalized.length > maxTextChars
  };
}

function valueToCellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function sheetToText(sheet) {
  const rows = Array.isArray(sheet?.data) ? sheet.data : [];
  const body = rows
    .map((row) => (Array.isArray(row) ? row.map(valueToCellText).join("\t") : valueToCellText(row)))
    .filter((line) => line.trim())
    .join("\n");
  return `工作表：${sheet?.sheet || "Sheet"}\n${body}`.trim();
}

export function canParseOnServer(fileName = "", mimeType = "") {
  const extension = fileExtension(fileName);
  return serverParseableExtensions.has(extension)
    || mimeType === "application/pdf"
    || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export async function parseAttachmentBuffer(file, { maxTextChars = 60000 } = {}) {
  const safeName = normalizeUploadFileName(file.originalname);
  const extension = fileExtension(safeName);
  const mimeType = file.mimetype || "application/octet-stream";

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const parser = new PDFParse({ data: file.buffer });
    try {
      const result = await parser.getText();
      return {
        kind: "document",
        type: mimeType,
        ...limitText(result.text, maxTextChars)
      };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (extension === ".docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return {
      kind: "document",
      type: mimeType,
      ...limitText(result.value, maxTextChars)
    };
  }

  if (extension === ".xlsx" || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const sheets = await readExcelFile(file.buffer);
    const text = sheets.map(sheetToText).join("\n\n");
    return {
      kind: "spreadsheet",
      type: mimeType,
      ...limitText(text, maxTextChars)
    };
  }

  throw Object.assign(new Error("该文件类型需要在前端处理，或暂不支持解析"), { statusCode: 415 });
}
