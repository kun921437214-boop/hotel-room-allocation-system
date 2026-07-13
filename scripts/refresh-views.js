const crypto = require("node:crypto");

const baseUrl = String(
  process.env.MAINTENANCE_BASE_URL ||
  process.argv[2] ||
  "https://hotel-room-allocation-system-jade.vercel.app"
).replace(/\/$/, "");
const stages = String(process.env.MAINTENANCE_STAGES || "schema,backup,people,personList,hotelStats,roleStats,cleanup")
  .split(",")
  .map((stage) => stage.trim())
  .filter(Boolean);
const runId = process.env.MAINTENANCE_RUN_ID || `VIEW-REFRESH-${new Date().toISOString().slice(0, 10)}`;
const maintenanceToken = process.env.MAINTENANCE_TOKEN || "";

async function jsonRequest(method, payload) {
  const response = await fetch(`${baseUrl}/api/state`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(maintenanceToken ? { "x-maintenance-token": maintenanceToken } : {})
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`${method} ${response.status}：${data.error || "维护请求失败"}`);
  }
  return data;
}

function stateCounts(state) {
  const needs = Array.isArray(state?.needs) ? state.needs : [];
  return {
    needs: needs.length,
    people: needs.reduce((sum, need) => sum + 1 + (Array.isArray(need.companions) ? need.companions.length : 0), 0)
  };
}

async function run() {
  if (!maintenanceToken) throw new Error("请先设置 MAINTENANCE_TOKEN，再执行线上维护。");
  const initial = await jsonRequest("GET");
  let expectedVersion = initial.version;
  const initialCounts = stateCounts(initial.state);
  console.log(`开始分段维护：${initialCounts.needs} 条需求，${initialCounts.people} 人。`);

  for (const stage of stages) {
    const operationId = `${runId}:${stage}:${crypto.createHash("sha256").update(expectedVersion).digest("hex").slice(0, 12)}`;
    const result = await jsonRequest("PUT", {
      action: "refreshViews",
      stage,
      operationId,
      clientId: "LOCAL-MAINTENANCE",
      operator: process.env.MAINTENANCE_OPERATOR || "本地维护脚本",
      baseVersion: expectedVersion
    });
    const counts = stateCounts(result.state);
    if (counts.needs !== initialCounts.needs || counts.people !== initialCounts.people) {
      throw new Error(`步骤 ${stage} 后主数据数量发生变化，已停止后续维护。`);
    }
    if (result.version !== expectedVersion) {
      throw new Error(`步骤 ${stage} 期间线上主数据被更新，请稍后重新运行维护。`);
    }
    const detail = result.maintenance?.table
      ? `：${result.maintenance.table} ${result.maintenance.rows} 行`
      : result.maintenance?.groupId
        ? `：备份组 ${result.maintenance.groupId}`
        : "";
    console.log(`完成 ${stage}${detail}`);
  }

  const finalState = await jsonRequest("GET");
  const finalCounts = stateCounts(finalState.state);
  if (finalState.version !== expectedVersion || finalCounts.needs !== initialCounts.needs || finalCounts.people !== initialCounts.people) {
    throw new Error("维护后核对失败：线上主数据发生变化。");
  }
  console.log(`维护完成：${finalCounts.needs} 条需求，${finalCounts.people} 人，主数据未变化。`);
}

// Node 的连接池可能复用不保持事件循环活跃的套接字；维护结束前显式保持进程存活。
const keepAlive = setInterval(() => {}, 1000);
run()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
