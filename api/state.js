const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || process.env.FEISHU_BITABLE_APP_TOKEN || "Mg3abeaEya2QptsxOjIchxSLndd";
const SYNC_TABLE_NAME = process.env.FEISHU_SYNC_TABLE_NAME || "系统同步数据";
const SYNC_RECORD_KEY = process.env.FEISHU_SYNC_RECORD_KEY || "hotel-room-state-v1";

const sampleData = {
  hotels: [
    { id: "汉庭酒店", name: "汉庭酒店", address: "", contact: "", phone: "" },
    { id: "如家酒店", name: "如家酒店", address: "", contact: "", phone: "" },
    { id: "万豪酒店", name: "万豪酒店", address: "", contact: "", phone: "" }
  ],
  rooms: [],
  needs: [],
  bookings: [],
  changes: [],
  eventDates: []
};

let tokenCache = { token: "", expiresAt: 0 };
let tableIdCache = "";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,PUT,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function tenantAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("后端缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量。");
  }
  const response = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取飞书访问令牌失败：${body.msg || response.statusText}`);
  }
  tokenCache = {
    token: body.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expire || 7200) - 300) * 1000
  };
  return tokenCache.token;
}

async function feishu(method, path, payload) {
  const token = await tenantAccessToken();
  const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    throw new Error(`飞书接口失败：${body.msg || response.statusText}`);
  }
  return body.data || {};
}

async function ensureSyncTableId() {
  if (process.env.FEISHU_SYNC_TABLE_ID) return process.env.FEISHU_SYNC_TABLE_ID;
  if (tableIdCache) return tableIdCache;

  const tables = await feishu("GET", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables?page_size=100`);
  const existing = (tables.items || []).find((table) => table.name === SYNC_TABLE_NAME);
  if (existing?.table_id) {
    tableIdCache = existing.table_id;
    return tableIdCache;
  }

  const fields = [
    { field_name: "数据键", type: 1 },
    { field_name: "JSON内容", type: 1 },
    { field_name: "最后更新时间", type: 1 }
  ];
  const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables`, {
    table: {
      name: SYNC_TABLE_NAME,
      default_view_name: "同步数据",
      fields
    }
  });
  tableIdCache = created.table?.table_id || created.table_id;
  if (!tableIdCache) throw new Error("飞书同步表创建成功但没有返回 table_id。");
  return tableIdCache;
}

async function listRecords(tableId) {
  const data = await feishu("GET", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records?page_size=500`);
  return data.items || [];
}

async function getSyncRecord(tableId) {
  const records = await listRecords(tableId);
  return records.find((record) => record.fields?.["数据键"] === SYNC_RECORD_KEY);
}

async function createSyncRecord(tableId, state) {
  const fields = {
    "数据键": SYNC_RECORD_KEY,
    "JSON内容": JSON.stringify(state),
    "最后更新时间": new Date().toISOString()
  };
  return feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`, { fields });
}

async function updateSyncRecord(tableId, recordId, state) {
  const fields = {
    "JSON内容": JSON.stringify(state),
    "最后更新时间": new Date().toISOString()
  };
  return feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${recordId}`, { fields });
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (!["GET", "PUT"].includes(req.method)) return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const tableId = await ensureSyncTableId();
    const record = await getSyncRecord(tableId);

    if (req.method === "GET") {
      if (!record) {
        await createSyncRecord(tableId, sampleData);
        return json(res, 200, { ok: true, state: sampleData, tableId, created: true });
      }
      const raw = record.fields?.["JSON内容"] || "";
      const state = raw ? JSON.parse(raw) : sampleData;
      return json(res, 200, { ok: true, state, tableId, updatedAt: record.fields?.["最后更新时间"] || "" });
    }

    const body = await readJsonBody(req);
    if (!body?.state || typeof body.state !== "object") {
      return json(res, 400, { ok: false, error: "缺少 state 数据。" });
    }
    if (record) {
      await updateSyncRecord(tableId, record.record_id, body.state);
    } else {
      await createSyncRecord(tableId, body.state);
    }
    return json(res, 200, { ok: true, tableId });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "同步失败" });
  }
};
