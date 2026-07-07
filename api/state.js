const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || process.env.FEISHU_BITABLE_APP_TOKEN || "Mg3abeaEya2QptsxOjIchxSLndd";
const SYNC_TABLE_NAME = process.env.FEISHU_SYNC_TABLE_NAME || "系统同步数据";
const SYNC_RECORD_KEY = process.env.FEISHU_SYNC_RECORD_KEY || "hotel-room-state-v1";
const ACTIVE_READABLE_TABLE_NAMES = ["住宿人员名单", "酒店统计查看", "角色统计查看"];
const OBSOLETE_READABLE_TABLE_NAMES = ["入住需求查看", "酒店房间查看", "分房记录查看", "变更记录查看"];
const ARRANGEMENT_HOTELS = ["汉庭", "如家", "万豪"];
const IDENTITY_OPTIONS = ["工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"];
const ROOM_TYPE_FIELDS = ["双标", "大床", "套房", "其他"];

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
    await ensureReadableFields(readableTableCache[tableName], fields);
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

async function listFields(tableId) {
  const data = await feishu("GET", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields?page_size=100`);
  return data.items || [];
}

async function ensureReadableFields(tableId, fields) {
  const existingFields = await listFields(tableId);
  const existingNames = new Set(existingFields.map((field) => field.field_name));
  for (const fieldName of fields) {
    if (!existingNames.has(fieldName)) {
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields`, {
        field_name: fieldName,
        type: 1
      });
    }
  }
}

async function deleteObsoleteReadableTables() {
  const tables = await allTables();
  const keepNames = new Set([SYNC_TABLE_NAME, ...ACTIVE_READABLE_TABLE_NAMES]);
  for (const tableName of OBSOLETE_READABLE_TABLE_NAMES) {
    if (keepNames.has(tableName)) continue;
    const table = tables.find((item) => item.name === tableName);
    if (!table?.table_id) continue;
    try {
      await feishu("DELETE", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${table.table_id}`);
      delete readableTableCache[tableName];
    } catch {
      // 删除旧展示表失败不影响核心同步和新展示表刷新。
    }
  }
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

function dateToUtcValue(date) {
  const [year, month, day] = String(date || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
}

function dateToValue(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function nightsBetween(start, end) {
  const startValue = dateToUtcValue(start);
  const endValue = dateToUtcValue(end);
  if (startValue === null || endValue === null || endValue <= startValue) return [];
  const dates = [];
  for (let cursor = startValue; cursor < endValue; cursor += 86400000) {
    dates.push(dateToValue(cursor));
  }
  return dates;
}

function stayDayCount(need) {
  const start = dateToUtcValue(need.checkIn);
  const end = dateToUtcValue(need.checkOut);
  if (start === null || end === null || end <= start) return 0;
  return Math.round((end - start) / 86400000);
}

function normalizedNeedHotel(hotel) {
  if (hotel === "汉庭酒店") return "汉庭";
  if (hotel === "如家酒店") return "如家";
  if (hotel === "万豪酒店") return "万豪";
  return hotel || "";
}

function peopleForNeed(need) {
  const companions = Array.isArray(need.companions) ? need.companions : [];
  return [need, ...companions];
}

function personIdentity(person, fallback = "") {
  return person?.identity || fallback || "其他";
}

function normalizedRoomType(type) {
  return ROOM_TYPE_FIELDS.includes(type) ? type : "其他";
}

function activeDates(state) {
  const dates = Array.from(new Set((state.needs || []).flatMap((need) => nightsBetween(need.checkIn, need.checkOut)))).sort();
  if (dates.length) return dates;
  return Array.isArray(state.eventDates) ? [...state.eventDates].sort() : [];
}

function needHotels(state) {
  const hotels = new Set(ARRANGEMENT_HOTELS);
  (state.needs || []).forEach((need) => {
    const hotel = normalizedNeedHotel(need.hotel);
    if (hotel) hotels.add(hotel);
  });
  return Array.from(hotels);
}

function roleIdentities(state) {
  const identities = new Set(IDENTITY_OPTIONS);
  (state.needs || []).forEach((need) => {
    peopleForNeed(need).forEach((person) => identities.add(personIdentity(person, need.identity)));
  });
  return Array.from(identities).filter(Boolean);
}

function needMatchesIdentity(need, identity) {
  return peopleForNeed(need).some((person) => personIdentity(person, need.identity) === identity);
}

function needStaysOnDate(need, date) {
  return need.status !== "已取消" && need.checkIn && need.checkOut && date >= need.checkIn && date < need.checkOut;
}

function roomTypeCounts(needs) {
  const counts = Object.fromEntries(ROOM_TYPE_FIELDS.map((field) => [field, 0]));
  needs.forEach((need) => {
    counts[normalizedRoomType(need.roomType)] += 1;
  });
  return counts;
}

function statRow(key, date, hotel, identity, needs) {
  const counts = roomTypeCounts(needs);
  const total = ROOM_TYPE_FIELDS.reduce((sum, field) => sum + counts[field], 0);
  return {
    "统计维度": key,
    "日期": date,
    "酒店": hotel,
    "人员性质": identity,
    "双标": String(counts["双标"]),
    "大床": String(counts["大床"]),
    "套房": String(counts["套房"]),
    "其他": String(counts["其他"]),
    "合计": String(total)
  };
}

function personListRows(state) {
  const rows = [];
  let sequence = 1;
  (state.needs || []).forEach((need) => {
    peopleForNeed(need).forEach((person) => {
      rows.push({
        "序号": String(sequence),
        "姓名": person.name || "",
        "性别": person.gender || "",
        "电话": person.phone || "",
        "身份证号": person.idNo || "",
        "人员性质": personIdentity(person, need.identity),
        "入住日期": need.checkIn || "",
        "离店日期": need.checkOut || "",
        "入住天数": String(stayDayCount(need)),
        "安排酒店": normalizedNeedHotel(need.hotel),
        "房间号": need.roomNo || "",
        "房间类型": need.roomType || "",
        "备注": need.note || ""
      });
      sequence += 1;
    });
  });
  return rows;
}

function hotelStatRows(state) {
  const rows = [];
  activeDates(state).forEach((date) => {
    needHotels(state).forEach((hotel) => {
      roleIdentities(state).forEach((identity) => {
        const needs = (state.needs || []).filter((need) => (
          needStaysOnDate(need, date) &&
          normalizedNeedHotel(need.hotel) === hotel &&
          needMatchesIdentity(need, identity)
        ));
        const total = needs.length;
        if (total > 0) rows.push(statRow(`${date}｜${hotel}｜${identity}`, date, hotel, identity, needs));
      });
    });
  });
  return rows;
}

function roleStatRows(state) {
  const rows = [];
  activeDates(state).forEach((date) => {
    roleIdentities(state).forEach((identity) => {
      needHotels(state).forEach((hotel) => {
        const needs = (state.needs || []).filter((need) => (
          needStaysOnDate(need, date) &&
          needMatchesIdentity(need, identity) &&
          normalizedNeedHotel(need.hotel) === hotel
        ));
        const total = needs.length;
        if (total > 0) rows.push(statRow(`${date}｜${identity}｜${hotel}`, date, hotel, identity, needs));
      });
    });
  });
  return rows;
}

function readableMirrorTables(state) {
  return [
    {
      name: "住宿人员名单",
      keyField: "序号",
      fields: ["序号", "姓名", "性别", "电话", "身份证号", "人员性质", "入住日期", "离店日期", "入住天数", "安排酒店", "房间号", "房间类型", "备注"],
      rows: personListRows(state)
    },
    {
      name: "酒店统计查看",
      keyField: "统计维度",
      fields: ["统计维度", "日期", "酒店", "人员性质", "双标", "大床", "套房", "其他", "合计"],
      rows: hotelStatRows(state)
    },
    {
      name: "角色统计查看",
      keyField: "统计维度",
      fields: ["统计维度", "日期", "人员性质", "酒店", "双标", "大床", "套房", "其他", "合计"],
      rows: roleStatRows(state).map((row) => ({
        "统计维度": row["统计维度"],
        "日期": row["日期"],
        "人员性质": row["人员性质"],
        "酒店": row["酒店"],
        "双标": row["双标"],
        "大床": row["大床"],
        "套房": row["套房"],
        "其他": row["其他"],
        "合计": row["合计"]
      }))
    }
  ];
}

async function syncReadableMirrorTables(state) {
  for (const table of readableMirrorTables(state)) {
    const tableId = await ensureReadableTable(table.name, table.fields);
    await upsertReadableRecords(tableId, table.keyField, table.rows);
  }
  await deleteObsoleteReadableTables();
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
    let mirrorError = "";
    try {
      await syncReadableMirrorTables(body.state);
    } catch (error) {
      mirrorError = error.message || "飞书查看表同步失败";
    }
    return json(res, 200, { ok: true, tableId, mirrorError });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "同步失败" });
  }
};
