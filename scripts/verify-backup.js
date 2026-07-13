const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

async function run() {
  const file = path.resolve(String(process.argv[2] || ""));
  if (!process.argv[2] || !file.endsWith(".json.gz")) {
    throw new Error("用法：node scripts/verify-backup.js /path/to/hotel-state-xxx.json.gz");
  }
  const checksumFile = `${file}.sha256`;
  const expected = (await fs.readFile(checksumFile, "utf8")).trim().split(/\s+/)[0];
  const json = zlib.gunzipSync(await fs.readFile(file)).toString("utf8");
  const actual = crypto.createHash("sha256").update(json).digest("hex");
  if (!expected || actual !== expected) throw new Error("备份校验失败：校验和不一致。");
  const payload = JSON.parse(json);
  if (!payload.version || !Array.isArray(payload.state?.needs)) throw new Error("备份结构无效。");
  const people = payload.state.needs.reduce((sum, need) => sum + 1 + (need.companions?.length || 0), 0);
  console.log(`备份有效：${path.basename(file)}，${payload.state.needs.length} 条需求，${people} 人，版本 ${payload.version}`);
}

run().catch((error) => {
  console.error(`备份验证失败：${error.message || "未知错误"}`);
  process.exitCode = 1;
});
