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
let readableTableCache = {};

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

async function allTables() {
  const data = await feishu("GET", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables?page_size=100`);
  return data.items || [];
}

async function ensureReadableTable(tableName, fields) {
  if (readableTableCache[tableName]) return readableTableCache[tableName];
  const tables = await allTables();
  const existing = tables.find((table) => table.name === tableName);
  if (existing?.table_id) {
    readableTableCache[tableName] = existing.table_id;
    return readableTableCache[tableName];
  }

  const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables`, {
    table: {
      name: tableName,
      default_view_name: "全部",
      fields: fields.map((fieldName) => ({ field_name: fieldName, type: 1 }))
    }
  });
  readableTableCache[tableName] = created.table?.table_id || created.table_id;
  if (!readableTableCache[tableName]) throw new Error(`飞书查看表 ${tableName} 创建成功但没有返回 table_id。`);
  return readableTableCache[tableName];
}

async function listRecords(tableId) {
  const data = await feishu("GET", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records?page_size=500`);
  return data.items || [];
}

async function upsertReadableRecords(tableId, keyField, rows) {
  const existingRecords = await listRecords(tableId);
  const existingByKey = new Map(existingRecords.map((record) => [String(record.fields?.[keyField] || ""), record]));
  const incomingKeys = new Set(rows.map((row) => String(row[keyField] || "")));

  for (const row of rows) {
    const key = String(row[keyField] || "");
    if (!key) continue;
    const record = existingByKey.get(key);
    if (record?.record_id) {
      await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${record.record_id}`, { fields: row });
    } else {
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`, { fields: row });
    }
  }

  for (const record of existingRecords) {
    const key = String(record.fields?.[keyField] || "");
    if (key && !incomingKeys.has(key)) {
      await feishu("DELETE", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${record.record_id}`);
    }
  }
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

function hotelName(state, id) {
  return (state.hotels || []).find((hotel) => hotel.id === id || hotel.name === id)?.name || id || "";
}

function roomById(state, roomId) {
  return (state.rooms || []).find((room) => room.id === roomId);
}

function needById(state, needId) {
  return (state.needs || []).find((need) => need.id === needId);
}

function roomLabel(state, roomId) {
  const room = roomById(state, roomId);
  if (!room) return roomId || "";
  return `${hotelName(state, room.hotel || room.hotelId)} ${room.roomNo}`;
}

function assignedRoomTime(state, needId) {
  return (state.bookings || [])
    .filter((booking) => booking.needId === needId && booking.status !== "取消")
    .map((booking) => `${roomLabel(state, booking.roomId)}｜${booking.checkIn || ""} 至 ${booking.checkOut || ""}`)
    .join("\n");
}

function readableMirrorTables(state) {
  const rooms = (state.rooms || []).map((room) => ({
    "房间ID": room.id || "",
    "酒店": hotelName(state, room.hotel || room.hotelId),
    "房间号": room.roomNo || "",
    "楼层": String(room.floor ?? ""),
    "房型": room.type || "",
    "可住人数": String(room.capacity ?? ""),
    "可用时间": `${room.availableFrom || ""} 至 ${room.availableTo || ""}`,
    "默认用途": room.defaultUse || ""
  }));

  const needs = (state.needs || []).map((need) => ({
    "需求ID": need.id || "",
    "姓名/团队": need.name || "",
    "身份": need.identity || "",
    "联系方式": need.phone || "",
    "人数": String(need.people ?? ""),
    "入住日期": need.checkIn || "",
    "离店日期": need.checkOut || "",
    "期望房型": need.roomType || "",
    "分配状态": need.status || "",
    "已分配房间/时间": assignedRoomTime(state, need.id),
    "负责人": need.owner || "",
    "备注": need.note || ""
  }));

  const bookings = (state.bookings || []).map((booking) => {
    const need = needById(state, booking.needId) || {};
    return {
      "分房ID": booking.id || "",
      "入住对象": need.name || booking.needId || "",
      "身份": need.identity || "",
      "联系方式": need.phone || "",
      "酒店房间": roomLabel(state, booking.roomId),
      "入住日期": booking.checkIn || "",
      "离店日期": booking.checkOut || "",
      "人数": String(booking.people ?? ""),
      "分配用途": booking.purpose || "",
      "状态": booking.status || "",
      "是否确认": booking.confirmed || "",
      "是否到店": booking.checkedIn || "",
      "备注": booking.note || ""
    };
  });

  const changes = (state.changes || []).map((change) => ({
    "变更ID": change.id || "",
    "变更时间": change.time || "",
    "变更类型": change.type || "",
    "原酒店": change.oldHotel || "",
    "原房间": change.oldRoom || "",
    "新酒店": change.newHotel || "",
    "新房间": change.newRoom || "",
    "关联对象": change.person || "",
    "变更原因": change.reason || "",
    "操作人": change.operator || "",
    "同步酒店": change.hotelSynced || "",
    "同步入住人": change.guestSynced || "",
    "备注": change.note || ""
  }));

  return [
    { name: "酒店房间查看", keyField: "房间ID", fields: ["房间ID", "酒店", "房间号", "楼层", "房型", "可住人数", "可用时间", "默认用途"], rows: rooms },
    { name: "入住需求查看", keyField: "需求ID", fields: ["需求ID", "姓名/团队", "身份", "联系方式", "人数", "入住日期", "离店日期", "期望房型", "分配状态", "已分配房间/时间", "负责人", "备注"], rows: needs },
    { name: "分房记录查看", keyField: "分房ID", fields: ["分房ID", "入住对象", "身份", "联系方式", "酒店房间", "入住日期", "离店日期", "人数", "分配用途", "状态", "是否确认", "是否到店", "备注"], rows: bookings },
    { name: "变更记录查看", keyField: "变更ID", fields: ["变更ID", "变更时间", "变更类型", "原酒店", "原房间", "新酒店", "新房间", "关联对象", "变更原因", "操作人", "同步酒店", "同步入住人", "备注"], rows: changes }
  ];
}

async function syncReadableMirrorTables(state) {
  for (const table of readableMirrorTables(state)) {
    const tableId = await ensureReadableTable(table.name, table.fields);
    await upsertReadableRecords(tableId, table.keyField, table.rows);
  }
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
    await syncReadableMirrorTables(body.state);
    return json(res, 200, { ok: true, tableId });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "同步失败" });
  }
};
