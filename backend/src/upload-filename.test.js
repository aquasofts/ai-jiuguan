import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUploadFileName } from "./upload-filename.js";

test("normalizes UTF-8 file names decoded as Latin-1 by multipart parsers", () => {
  const mojibake = Buffer.from("中文资料.pdf", "utf8").toString("latin1");
  assert.equal(normalizeUploadFileName(mojibake), "中文资料.pdf");
});

test("keeps already readable Unicode and Latin file names", () => {
  assert.equal(normalizeUploadFileName("中文资料.pdf"), "中文资料.pdf");
  assert.equal(normalizeUploadFileName("resume final.pdf"), "resume final.pdf");
});

test("removes paths and control characters from uploaded file names", () => {
  assert.equal(normalizeUploadFileName("../目录/\u0000中文资料.pdf"), "中文资料.pdf");
});
