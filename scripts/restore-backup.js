const { _internal } = require("../api/state");

async function run() {
  const backupId = String(process.argv[2] || "").trim();
  if (!backupId) throw new Error("用法：node scripts/restore-backup.js <备份组ID>");
  if (process.env.CONFIRM_RESTORE_BACKUP !== backupId) {
    throw new Error(`为避免误恢复，请先设置 CONFIRM_RESTORE_BACKUP=${backupId}`);
  }
  const result = await _internal.restoreBackupById(backupId, {
    operationId: `RESTORE-${Date.now()}`,
    operator: process.env.RESTORE_OPERATOR || "本地恢复脚本"
  });
  const needs = result.state?.needs || [];
  const people = needs.reduce((sum, need) => sum + 1 + (Array.isArray(need.companions) ? need.companions.length : 0), 0);
  console.log(`恢复完成：${needs.length} 条需求，${people} 人，版本 ${result.version}`);
}

run().catch((error) => {
  console.error(`恢复失败：${error.message || "未知错误"}`);
  process.exitCode = 1;
});
