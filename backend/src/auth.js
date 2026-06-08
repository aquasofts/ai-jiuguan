import jwt from "jsonwebtoken";
import { readDb, publicUser, publicAdmin } from "./db.js";

const secret = () => process.env.JWT_SECRET || "dev-secret-change-me";

export function signUser(user) {
  return jwt.sign({ sub: user.id, type: "user" }, secret(), { expiresIn: "7d" });
}

export function signAdmin(admin) {
  return jwt.sign({ sub: admin.id, type: "admin" }, secret(), { expiresIn: "7d" });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export function requireUser(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ message: "请先登录" });
    const payload = jwt.verify(token, secret());
    if (payload.type !== "user") return res.status(403).json({ message: "权限不足" });
    const db = readDb();
    const user = db.users.find((item) => item.id === payload.sub);
    if (!user) return res.status(401).json({ message: "用户不存在" });
    if (user.status !== "active") return res.status(403).json({ message: "账号尚未通过审核" });
    req.user = publicUser(user);
    next();
  } catch {
    res.status(401).json({ message: "登录已过期" });
  }
}

export function requireAdmin(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ message: "请先登录管理员账号" });
    const payload = jwt.verify(token, secret());
    if (payload.type !== "admin") return res.status(403).json({ message: "权限不足" });
    const db = readDb();
    const admin = db.admins.find((item) => item.id === payload.sub);
    if (!admin) return res.status(401).json({ message: "管理员不存在" });
    req.admin = publicAdmin(admin);
    next();
  } catch {
    res.status(401).json({ message: "管理员登录已过期" });
  }
}
