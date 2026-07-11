const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const sourceUrl = String(process.env.BACKUP_SOURCE_URL || "https://hotel-room-allocation-system-jade.vercel.app").replace(/\/$/, "");
const backupDir = process.env.BACKUP_DIR;
const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 30));

async function fetchState() {
  const response = await fetch(`${sourceUrl}/api/state`, { signal: AbortSignal.timeout(30000), cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !Array.isArray(payload.state?.needs)) {
    throw new Error(payload.error || `读取线上数据失败：HTTP ${response.status}`);
  }
  return payload;
}

async function removeExpiredFiles(directory) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^hotel-state-.*\.(json\.gz|sha256)$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.stat(file);
    if (stat.mtimeMs < cutoff) await fs.unlink(file);
  }
}

async function run() {
  if (!backupDir) throw new Error("请设置 BACKUP_DIR，指向 NAS 或独立磁盘上的备份目录。");
  const payload = await fetchState();
  const generatedAt = new Date().toISOString();
  const json = JSON.stringify({ generatedAt, source: sourceUrl, version: payload.version, state: payload.state });
  const checksum = crypto.createHash("sha256").update(json).digest("hex");
  const compressed = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const filename = `hotel-state-${stamp}.json.gz`;
  await fs.mkdir(backupDir, { recursive: true });
  const target = path.join(backupDir, filename);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, compressed, { flag: "wx" });
  await fs.rename(temporary, target);
  await fs.writeFile(`${target}.sha256`, `${checksum}  ${filename}\n`, "utf8");
  const verified = zlib.gunzipSync(await fs.readFile(target)).toString("utf8");
  if (crypto.createHash("sha256").update(verified).digest("hex") !== checksum) throw new Error("备份写入后的校验失败。");
  await removeExpiredFiles(backupDir);
  const people = payload.state.needs.reduce((sum, need) => sum + 1 + (need.companions?.length || 0), 0);
  console.log(`独立备份完成：${target}，${payload.state.needs.length} 条需求，${people} 人。`);
}

run().catch((error) => {
  console.error(`独立备份失败：${error.message || "未知错误"}`);
  process.exitCode = 1;
});
