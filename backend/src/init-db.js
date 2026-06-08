import "dotenv/config";
import { initializeDatabase, seedDb, sqlitePath, legacyJsonPath } from "./db.js";

initializeDatabase();
await seedDb();

console.log(`SQLite 数据库已初始化：${sqlitePath}`);
console.log(`如果存在旧 JSON 数据，会自动从这里迁移：${legacyJsonPath}`);
