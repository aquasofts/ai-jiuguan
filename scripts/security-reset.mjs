import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const root = process.cwd();
const envPath = path.join(root, "backend/.env");
const envExamplePath = path.join(root, "backend/.env.example");

function readEnvLines() {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
  return fs.readFileSync(envPath, "utf8").split(/\r?\n/);
}

function setEnv(lines, key, value) {
  const prefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

const adminPassword = process.argv[2] || randomBytes(12).toString("base64url");
if (adminPassword.length < 12) {
  console.error("管理员密码至少需要 12 位。");
  process.exit(1);
}

const jwtSecret = randomBytes(32).toString("hex");
const lines = readEnvLines();
setEnv(lines, "JWT_SECRET", jwtSecret);
setEnv(lines, "ADMIN_PASSWORD", adminPassword);
fs.writeFileSync(envPath, `${lines.filter((line, index, array) => line || index < array.length - 1).join("\n")}\n`);
fs.chmodSync(envPath, 0o600);

let updatedDatabase = false;
const { initializeDatabase, readDb, writeDb } = await import("../backend/src/db.js");
initializeDatabase();
const db = readDb();
const adminUsernameLine = lines.find((line) => line.startsWith("ADMIN_USERNAME="));
const adminUsername = adminUsernameLine?.split("=").slice(1).join("=") || "admin";
const admin = db.admins.find((item) => item.username === adminUsername) || db.admins[0];

if (admin) {
  admin.passwordHash = await bcrypt.hash(adminPassword, 10);
  admin.updatedAt = new Date().toISOString();
  writeDb(db);
  updatedDatabase = true;
}

console.log("安全配置已更新。");
console.log(`管理员用户名：${lines.find((line) => line.startsWith("ADMIN_USERNAME="))?.split("=").slice(1).join("=") || "admin"}`);
console.log(`管理员密码：${adminPassword}`);
console.log("JWT_SECRET 已自动生成并写入 backend/.env。");
if (!updatedDatabase) {
  console.log("未发现已有管理员数据库记录；下次初始化数据库时会按 backend/.env 创建默认管理员。");
}
