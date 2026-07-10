const crypto = require("crypto");

const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || process.env.FEISHU_BITABLE_APP_TOKEN || "Mg3abeaEya2QptsxOjIchxSLndd";
const SYNC_TABLE_NAME = process.env.FEISHU_SYNC_TABLE_NAME || "系统同步数据";
const SYNC_RECORD_KEY = process.env.FEISHU_SYNC_RECORD_KEY || "hotel-room-state-v1";
const NEED_TABLE_NAME = "住宿需求核心表";
const PERSON_TABLE_NAME = "住宿人员明细表";
const OPERATION_TABLE_NAME = "操作记录表";
const BACKUP_TABLE_NAME = "每日备份表";
const ACTIVE_READABLE_TABLE_NAMES = ["住宿人员名单", "酒店统计查看", "角色统计查看"];
const OBSOLETE_READABLE_TABLE_NAMES = ["入住需求查看", "酒店房间查看", "分房记录查看", "变更记录查看"];
const ARRANGEMENT_HOTELS = ["诺富特", "宜必思", "施柏阁", "大观"];
const IDENTITY_OPTIONS = ["工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"];
const ROOM_TYPE_FIELDS = ["双标", "大床", "套房", "其他"];
const LEGACY_SNAPSHOT_MAX_BYTES = 90 * 1024;

const sampleData = {
  hotels: [
    { id: "诺富特", name: "诺富特", address: "", contact: "", phone: "" },
    { id: "宜必思", name: "宜必思", address: "", contact: "", phone: "" },
    { id: "施柏阁", name: "施柏阁", address: "", contact: "", phone: "" },
    { id: "大观", name: "大观", address: "", contact: "", phone: "" }
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
let coreTableCache = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return [350, 900, 1800][attempt] || 1800;
}

function retryableResponse(response, body) {
  if (!response) return true;
  const message = String(body?.msg || body?.error || "");
  return response.status === 429 || response.status >= 500 || /timeout|temporar|频率|限流|rate/i.test(message);
}

async function fetchJsonWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      clearTimeout(timer);
      if (response.ok || !retryableResponse(response, body) || attempt === 2) {
        return { response, body };
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === 2) throw error;
    }
    await sleep(retryDelay(attempt));
  }
  throw lastError || new Error("网络请求失败");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,PUT,POST,OPTIONS");
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
  const { response, body } = await fetchJsonWithRetry(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
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
  const { response, body } = await fetchJsonWithRetry(`${FEISHU_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  if (!response.ok || body.code !== 0) {
    throw new Error(`飞书接口失败：${body.msg || response.statusText}`);
  }
  return body.data || {};
}

function pagedPath(path, pageSize, pageToken = "") {
  const params = [`page_size=${pageSize}`];
  if (pageToken) params.push(`page_token=${encodeURIComponent(pageToken)}`);
  return `${path}${path.includes("?") ? "&" : "?"}${params.join("&")}`;
}

async function feishuItems(path, pageSize = 100) {
  const items = [];
  let pageToken = "";
  do {
    const data = await feishu("GET", pagedPath(path, pageSize, pageToken));
    items.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token || "" : "";
  } while (pageToken);
  return items;
}

async function ensureSyncTableId() {
  if (process.env.FEISHU_SYNC_TABLE_ID) return process.env.FEISHU_SYNC_TABLE_ID;
  if (tableIdCache) return tableIdCache;

  const tables = await allTables();
  const existing = tables.find((table) => table.name === SYNC_TABLE_NAME);
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
  return feishuItems(`/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables`, 100);
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

async function ensureCoreTable(tableName, fields) {
  if (coreTableCache[tableName]) return coreTableCache[tableName];
  const tables = await allTables();
  const existing = tables.find((table) => table.name === tableName);
  if (existing?.table_id) {
    coreTableCache[tableName] = existing.table_id;
    await ensureReadableFields(coreTableCache[tableName], fields);
    return coreTableCache[tableName];
  }

  const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables`, {
    table: {
      name: tableName,
      default_view_name: "全部",
      fields: fields.map((fieldName) => ({ field_name: fieldName, type: 1 }))
    }
  });
  coreTableCache[tableName] = created.table?.table_id || created.table_id;
  if (!coreTableCache[tableName]) throw new Error(`飞书核心表 ${tableName} 创建成功但没有返回 table_id。`);
  return coreTableCache[tableName];
}

async function listFields(tableId) {
  return feishuItems(`/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields`, 100);
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
  return feishuItems(`/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`, 500);
}

function chunkArray(items, size = 100) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function batchCreateRecords(tableId, records) {
  const created = [];
  for (const chunk of chunkArray(records, 100)) {
    if (!chunk.length) continue;
    try {
      const data = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_create`, { records: chunk });
      created.push(...(data.records || []));
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      for (const record of chunk) {
        const data = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`, record);
        created.push(data.record || data);
      }
    }
  }
  return created;
}

function canRetryBatchMethod(error) {
  return /404|not found|method|接口不存在|请求地址|unsupported/i.test(String(error?.message || ""));
}

async function batchUpdateRecords(tableId, records) {
  for (const chunk of chunkArray(records, 100)) {
    if (!chunk.length) continue;
    try {
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_update`, { records: chunk });
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      try {
        await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_update`, { records: chunk });
      } catch (fallbackError) {
        if (!canRetryBatchMethod(fallbackError)) throw fallbackError;
        for (const record of chunk) {
          await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${record.record_id}`, { fields: record.fields });
        }
      }
    }
  }
}

async function batchDeleteRecords(tableId, recordIds) {
  for (const chunk of chunkArray(recordIds, 100)) {
    if (!chunk.length) continue;
    try {
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_delete`, { records: chunk });
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      for (const recordId of chunk) {
        await feishu("DELETE", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${recordId}`);
      }
    }
  }
}

const NEED_FIELDS = ["需求ID", "入住日期", "离店日期", "安排酒店", "房间号", "房间类型", "备注", "上传批次", "上传时间", "创建时间", "更新时间", "是否删除"];
const PERSON_FIELDS = ["人员ID", "需求ID", "顺序", "姓名", "性别", "电话", "身份证号", "人员性质", "是否主人员", "上传批次", "更新时间", "是否删除"];
const OPERATION_FIELDS = ["操作ID", "操作时间", "操作类型", "需求ID", "上传批次", "影响条数", "操作人", "说明"];
const BACKUP_FIELDS = ["备份ID", "备份类型", "备份日期", "备份时间", "关联操作", "上传批次", "需求数", "人数", "间夜", "JSON内容", "说明"];

async function ensureCoreTableIds() {
  const needTableId = await ensureCoreTable(NEED_TABLE_NAME, NEED_FIELDS);
  const personTableId = await ensureCoreTable(PERSON_TABLE_NAME, PERSON_FIELDS);
  const operationTableId = await ensureCoreTable(OPERATION_TABLE_NAME, OPERATION_FIELDS);
  const backupTableId = await ensureCoreTable(BACKUP_TABLE_NAME, BACKUP_FIELDS);
  return { needTableId, personTableId, operationTableId, backupTableId };
}

async function upsertReadableRecords(tableId, keyField, rows) {
  const existingRecords = await listRecords(tableId);
  const duplicateRecordIds = new Set();
  const groupedExisting = new Map();
  existingRecords.forEach((record) => {
    const key = String(record.fields?.[keyField] || "");
    if (!key) return;
    if (!groupedExisting.has(key)) groupedExisting.set(key, []);
    groupedExisting.get(key).push(record);
  });
  for (const group of groupedExisting.values()) {
    if (group.length <= 1) continue;
    for (const duplicate of group.slice(1)) {
      await feishu("DELETE", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${duplicate.record_id}`);
      duplicateRecordIds.add(duplicate.record_id);
    }
  }

  const uniqueExistingRecords = existingRecords.filter((record) => !duplicateRecordIds.has(record.record_id));
  const existingByKey = new Map(uniqueExistingRecords.map((record) => [String(record.fields?.[keyField] || ""), record]));
  const incomingKeys = new Set(rows.map((row) => String(row[keyField] || "")));
  const creates = [];
  const updates = [];

  for (const row of rows) {
    const key = String(row[keyField] || "");
    if (!key) continue;
    const record = existingByKey.get(key);
    if (record?.record_id) {
      updates.push({ record_id: record.record_id, fields: row });
    } else {
      creates.push({ fields: row });
    }
  }
  await batchUpdateRecords(tableId, updates);
  await batchCreateRecords(tableId, creates);

  const deletes = [];
  for (const record of uniqueExistingRecords) {
    const key = String(record.fields?.[keyField] || "");
    if (key && !incomingKeys.has(key)) {
      deletes.push(record.record_id);
    }
  }
  await batchDeleteRecords(tableId, deletes);
}

async function getSyncRecord(tableId) {
  const records = await listRecords(tableId);
  return records.find((record) => record.fields?.["数据键"] === SYNC_RECORD_KEY);
}

function syncSnapshotText(snapshot) {
  return typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
}

async function createSyncRecord(tableId, snapshot) {
  const fields = {
    "数据键": SYNC_RECORD_KEY,
    "JSON内容": syncSnapshotText(snapshot),
    "最后更新时间": new Date().toISOString()
  };
  return feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`, { fields });
}

async function updateSyncRecord(tableId, recordId, snapshot) {
  const fields = {
    "JSON内容": syncSnapshotText(snapshot),
    "最后更新时间": new Date().toISOString()
  };
  return feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${recordId}`, { fields });
}

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stateVersion(state) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({
      needs: Array.isArray(state?.needs) ? state.needs : [],
      eventDates: Array.isArray(state?.eventDates) ? state.eventDates : []
    }))
    .digest("hex");
}

function coreKeyMap(records, keyField) {
  return new Map(records.map((record) => [String(record.fields?.[keyField] || ""), record]).filter(([key]) => key));
}

function isDeletedRecord(record) {
  return String(record.fields?.["是否删除"] || "") === "是";
}

function recordTime(record) {
  return Date.parse(record.fields?.["更新时间"] || record.fields?.["创建时间"] || "") || 0;
}

function activeUniqueRecords(records, keyField) {
  const bestByKey = new Map();
  for (const record of records.filter((item) => !isDeletedRecord(item))) {
    const key = String(record.fields?.[keyField] || "");
    if (!key) continue;
    const existing = bestByKey.get(key);
    if (!existing || recordTime(record) >= recordTime(existing)) bestByKey.set(key, record);
  }
  return Array.from(bestByKey.values());
}

async function deleteDuplicateActiveRecords(tableId, records, keyField) {
  let deletedCount = 0;
  const groups = new Map();
  const updates = [];
  for (const record of records.filter((item) => !isDeletedRecord(item))) {
    const key = String(record.fields?.[keyField] || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => recordTime(b) - recordTime(a));
    for (const duplicate of group.slice(1)) {
      updates.push({
        record_id: duplicate.record_id,
        fields: { ...duplicate.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
      deletedCount += 1;
    }
  }
  await batchUpdateRecords(tableId, updates);
  return deletedCount;
}

async function cleanupDuplicateCoreRecords(tableIds) {
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listRecords(needTableId);
  const personRecords = await listRecords(personTableId);
  const deletedNeeds = await deleteDuplicateActiveRecords(needTableId, needRecords, "需求ID");
  const deletedPeople = await deleteDuplicateActiveRecords(personTableId, personRecords, "人员ID");
  return { deletedNeeds, deletedPeople };
}

function needCoreFields(need, existingFields = {}) {
  const updatedAt = nowIso();
  const uploadBatch = need.uploadBatchId || need.uploadBatchName || existingFields["上传批次"] || "";
  const uploadTime = need.uploadBatchTime || existingFields["上传时间"] || "";
  return {
    "需求ID": need.id || "",
    "入住日期": need.checkIn || "",
    "离店日期": need.checkOut || "",
    "安排酒店": normalizedNeedHotel(need.hotel),
    "房间号": need.roomNo || "",
    "房间类型": need.roomType || "",
    "备注": need.note || "",
    "上传批次": uploadBatch,
    "上传时间": uploadTime,
    "创建时间": existingFields["创建时间"] || need.createdAt || updatedAt,
    "更新时间": updatedAt,
    "是否删除": "否"
  };
}

function needPeopleRows(need) {
  return peopleForNeed(need).map((person, index) => ({
    "人员ID": person.personId || `${need.id}-P${index + 1}`,
    "需求ID": need.id || "",
    "顺序": String(index + 1),
    "姓名": person.name || "",
    "性别": person.gender || "",
    "电话": person.phone || "",
    "身份证号": person.idNo || "",
    "人员性质": personIdentity(person, need.identity),
    "是否主人员": index === 0 ? "是" : "否",
    "上传批次": need.uploadBatchId || need.uploadBatchName || "",
    "更新时间": nowIso(),
    "是否删除": "否"
  }));
}

async function readCoreWriteContext(tableIds) {
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listRecords(needTableId);
  const personRecords = await listRecords(personTableId);
  const peopleByNeed = new Map();
  personRecords.forEach((record) => {
    const needId = String(record.fields?.["需求ID"] || "");
    if (!needId) return;
    if (!peopleByNeed.has(needId)) peopleByNeed.set(needId, []);
    peopleByNeed.get(needId).push(record);
  });
  return {
    needById: coreKeyMap(needRecords, "需求ID"),
    peopleByNeed
  };
}

async function upsertNeedCore(need, tableIds, context = null) {
  if (!need?.id) throw new Error("缺少需求ID，无法保存。");
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const writeContext = context || await readCoreWriteContext(tableIds);
  const existingNeed = writeContext.needById.get(String(need.id));
  const needFields = needCoreFields(need, existingNeed?.fields || {});
  if (existingNeed?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records/${existingNeed.record_id}`, { fields: needFields });
    writeContext.needById.set(String(need.id), { ...existingNeed, fields: needFields });
  } else {
    const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records`, { fields: needFields });
    writeContext.needById.set(String(need.id), {
      record_id: created.record?.record_id || created.record_id || "",
      fields: needFields
    });
  }

  const personRows = needPeopleRows(need);
  const existingPeople = writeContext.peopleByNeed.get(need.id) || [];
  const existingPeopleById = coreKeyMap(existingPeople, "人员ID");
  const incomingPersonIds = new Set(personRows.map((row) => row["人员ID"]));
  for (const row of personRows) {
    const existing = existingPeopleById.get(row["人员ID"]);
    if (existing?.record_id) {
      await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records/${existing.record_id}`, { fields: row });
      existing.fields = row;
    } else {
      const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records`, { fields: row });
      existingPeople.push({
        record_id: created.record?.record_id || created.record_id || "",
        fields: row
      });
    }
  }

  for (const record of existingPeople) {
    const personId = String(record.fields?.["人员ID"] || "");
    if (personId && !incomingPersonIds.has(personId) && !isDeletedRecord(record)) {
      await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records/${record.record_id}`, {
        fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
      record.fields = { ...record.fields, "更新时间": nowIso(), "是否删除": "是" };
    }
  }
  writeContext.peopleByNeed.set(need.id, existingPeople);
}

async function upsertNeedsCore(needs, tableIds, context = null) {
  const validNeeds = (needs || []).filter((need) => need?.id);
  if (!validNeeds.length) return { savedNeeds: 0, savedPeople: 0 };
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const writeContext = context || await readCoreWriteContext(tableIds);
  const needCreates = [];
  const needCreateIds = [];
  const needUpdates = [];

  for (const need of validNeeds) {
    const existingNeed = writeContext.needById.get(String(need.id));
    const fields = needCoreFields(need, existingNeed?.fields || {});
    if (existingNeed?.record_id) {
      needUpdates.push({ record_id: existingNeed.record_id, fields });
      writeContext.needById.set(String(need.id), { ...existingNeed, fields });
    } else {
      needCreates.push({ fields });
      needCreateIds.push(String(need.id));
    }
  }

  await batchUpdateRecords(needTableId, needUpdates);
  const createdNeeds = await batchCreateRecords(needTableId, needCreates);
  createdNeeds.forEach((record, index) => {
    const id = needCreateIds[index];
    if (!id) return;
    writeContext.needById.set(id, {
      record_id: record.record_id || "",
      fields: record.fields || needCreates[index]?.fields || {}
    });
  });

  const personCreates = [];
  const personUpdates = [];
  let savedPeople = 0;
  for (const need of validNeeds) {
    const personRows = needPeopleRows(need);
    savedPeople += personRows.length;
    const existingPeople = writeContext.peopleByNeed.get(need.id) || [];
    const existingPeopleById = coreKeyMap(existingPeople, "人员ID");
    const incomingPersonIds = new Set(personRows.map((row) => row["人员ID"]));
    for (const row of personRows) {
      const existing = existingPeopleById.get(row["人员ID"]);
      if (existing?.record_id) {
        personUpdates.push({ record_id: existing.record_id, fields: row });
        existing.fields = row;
      } else {
        personCreates.push({ fields: row });
      }
    }

    for (const record of existingPeople) {
      const personId = String(record.fields?.["人员ID"] || "");
      if (personId && !incomingPersonIds.has(personId) && !isDeletedRecord(record)) {
        const fields = { ...record.fields, "更新时间": nowIso(), "是否删除": "是" };
        personUpdates.push({ record_id: record.record_id, fields });
        record.fields = fields;
      }
    }
  }

  await batchUpdateRecords(personTableId, personUpdates);
  await batchCreateRecords(personTableId, personCreates);
  return { savedNeeds: validNeeds.length, savedPeople };
}

async function deleteNeedCore(needId, tableIds) {
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listRecords(needTableId);
  const needRecord = coreKeyMap(needRecords, "需求ID").get(String(needId || ""));
  if (needRecord?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records/${needRecord.record_id}`, {
      fields: { ...needRecord.fields, "更新时间": nowIso(), "是否删除": "是" }
    });
  }

  const personRecords = await listRecords(personTableId);
  for (const record of personRecords.filter((item) => item.fields?.["需求ID"] === needId && !isDeletedRecord(item))) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records/${record.record_id}`, {
      fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
    });
  }
}

async function deleteNeedsCore(needIds, tableIds) {
  const ids = new Set((needIds || []).map((id) => String(id || "")).filter(Boolean));
  if (!ids.size) return;
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listRecords(needTableId);
  const needUpdates = [];
  for (const record of needRecords) {
    const needId = String(record.fields?.["需求ID"] || "");
    if (ids.has(needId) && !isDeletedRecord(record)) {
      needUpdates.push({
        record_id: record.record_id,
        fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
    }
  }

  const personRecords = await listRecords(personTableId);
  const personUpdates = [];
  for (const record of personRecords) {
    const needId = String(record.fields?.["需求ID"] || "");
    if (ids.has(needId) && !isDeletedRecord(record)) {
      personUpdates.push({
        record_id: record.record_id,
        fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
    }
  }
  await batchUpdateRecords(needTableId, needUpdates);
  await batchUpdateRecords(personTableId, personUpdates);
}

async function recordOperation(type, needId, description, tableIds, options = {}) {
  const { operationTableId } = tableIds || await ensureCoreTableIds();
  const id = `OP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${operationTableId}/records`, {
    fields: {
      "操作ID": id,
      "操作时间": nowIso(),
      "操作类型": type,
      "需求ID": needId || "",
      "上传批次": options.batchId || "",
      "影响条数": String(options.count || ""),
      "操作人": "网站",
      "说明": description || ""
    }
  });
}

function stateSummary(state) {
  const needs = Array.isArray(state?.needs) ? state.needs : [];
  return {
    needCount: needs.length,
    peopleCount: needs.reduce((sum, need) => sum + peopleForNeed(need).length, 0),
    nightCount: needs.reduce((sum, need) => sum + nightsBetween(need.checkIn, need.checkOut).length, 0)
  };
}

function snapshotPayload(state) {
  const fullSnapshot = JSON.stringify(state);
  if (Buffer.byteLength(fullSnapshot, "utf8") <= LEGACY_SNAPSHOT_MAX_BYTES) {
    return { json: fullSnapshot, compact: false };
  }
  return {
    compact: true,
    json: JSON.stringify({
      schema: "core-tables-v1",
      mode: "summary",
      generatedAt: nowIso(),
      summary: stateSummary(state),
      hotels: Array.isArray(state?.hotels) ? state.hotels : [],
      eventDates: Array.isArray(state?.eventDates) ? state.eventDates : [],
      notice: "住宿明细已超过单字段备份容量，请以住宿需求核心表和住宿人员明细表为准。"
    })
  };
}

function backupFields(state, options = {}) {
  const date = options.date || todayKey();
  const summary = stateSummary(state);
  const snapshot = snapshotPayload(state);
  return {
    "备份ID": options.id || `BACKUP-${date}-${Date.now()}`,
    "备份类型": options.type || "每日备份",
    "备份日期": date,
    "备份时间": nowIso(),
    "关联操作": options.operation || "",
    "上传批次": options.batchId || "",
    "需求数": String(summary.needCount),
    "人数": String(summary.peopleCount),
    "间夜": String(summary.nightCount),
    "JSON内容": snapshot.json,
    "说明": [
      options.reason || "网站自动备份",
      snapshot.compact ? "明细数据量较大，已保存安全摘要，完整明细以核心表为准" : ""
    ].filter(Boolean).join("；")
  };
}

async function upsertDailyBackup(state, tableIds, reason = "网站自动每日备份") {
  const { backupTableId } = tableIds || await ensureCoreTableIds();
  const date = todayKey();
  const fields = backupFields(state, {
    id: `DAILY-${date}`,
    type: "每日备份",
    date,
    reason
  });
  const records = await listRecords(backupTableId);
  const existing = records.find((record) => {
    const fields = record.fields || {};
    return fields["备份ID"] === `DAILY-${date}` || (!fields["备份ID"] && String(fields["备份日期"] || "") === date);
  });
  if (existing?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${backupTableId}/records/${existing.record_id}`, { fields });
  } else {
    await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${backupTableId}/records`, { fields });
    await recordOperation("每日备份", "", `${date} 已生成每日备份`, tableIds, { count: stateSummary(state).needCount });
  }
}

async function createOperationBackup(state, tableIds, options = {}) {
  const { backupTableId } = tableIds || await ensureCoreTableIds();
  const date = todayKey();
  const fields = backupFields(state, {
    id: `BEFORE-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "操作前备份",
    date,
    operation: options.operation || "",
    batchId: options.batchId || "",
    reason: options.reason || "高风险操作前自动备份"
  });
  await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${backupTableId}/records`, { fields });
}

async function tryDailyBackup(state, tableIds, reason) {
  try {
    await upsertDailyBackup(state, tableIds, reason);
  } catch {
    // 备份失败不阻断日常录入和同步，操作记录表里仍保留核心动作。
  }
}

function stateFromCoreRecords(needRecords, personRecords) {
  const activeNeedRecords = activeUniqueRecords(needRecords, "需求ID");
  const peopleByNeed = new Map();
  activeUniqueRecords(personRecords, "人员ID")
    .sort((a, b) => Number(a.fields?.["顺序"] || 0) - Number(b.fields?.["顺序"] || 0))
    .forEach((record) => {
      const needId = String(record.fields?.["需求ID"] || "");
      if (!needId) return;
      if (!peopleByNeed.has(needId)) peopleByNeed.set(needId, []);
      peopleByNeed.get(needId).push({
        personId: record.fields?.["人员ID"] || "",
        name: record.fields?.["姓名"] || "",
        gender: record.fields?.["性别"] || "",
        phone: record.fields?.["电话"] || "",
        idNo: record.fields?.["身份证号"] || "",
        identity: record.fields?.["人员性质"] || "其他"
      });
    });

  const needs = activeNeedRecords.map((record) => {
    const fields = record.fields || {};
    const people = peopleByNeed.get(fields["需求ID"]) || [];
    const [mainPerson = {}, ...companions] = people;
    return {
      id: fields["需求ID"] || "",
      name: mainPerson.name || "",
      gender: mainPerson.gender || "",
      phone: mainPerson.phone || "",
      idNo: mainPerson.idNo || "",
      identity: mainPerson.identity || "其他",
      companions,
      people: Math.max(1, people.length),
      adults: Math.max(1, people.length),
      children: 0,
      checkIn: fields["入住日期"] || "",
      checkOut: fields["离店日期"] || "",
      hotel: normalizedNeedHotel(fields["安排酒店"]),
      roomNo: fields["房间号"] || "",
      roomType: fields["房间类型"] || "",
      note: fields["备注"] || "",
      uploadBatchId: fields["上传批次"] || "",
      uploadBatchName: fields["上传批次"] || "",
      uploadBatchTime: fields["上传时间"] || "",
      sameRoom: "是",
      share: "否",
      quiet: "否",
      smokeFree: "否",
      lowFloor: "否",
      nearElevator: "否",
      confirmed: "否"
    };
  }).filter((need) => need.id);

  return {
    ...sampleData,
    needs,
    eventDates: Array.from(new Set(needs.flatMap((need) => nightsBetween(need.checkIn, need.checkOut)))).sort()
  };
}

async function readCoreState(tableIds = null) {
  const ids = tableIds || await ensureCoreTableIds();
  const needRecords = await listRecords(ids.needTableId);
  const personRecords = await listRecords(ids.personTableId);
  const state = stateFromCoreRecords(needRecords, personRecords);
  return { state, version: stateVersion(state), tableIds: ids, hasCoreRecords: needRecords.length > 0 };
}

async function migrateLegacyStateIfNeeded() {
  const core = await readCoreState();
  if (core.hasCoreRecords) return core.state;

  const tableId = await ensureSyncTableId();
  const record = await getSyncRecord(tableId);
  const raw = record?.fields?.["JSON内容"] || "";
  const legacyState = raw ? JSON.parse(raw) : sampleData;
  const legacyNeeds = Array.isArray(legacyState.needs) ? legacyState.needs : [];
  if (!legacyNeeds.length) return core.state;

  const context = await readCoreWriteContext(core.tableIds);
  for (const need of legacyNeeds) await upsertNeedCore(need, core.tableIds, context);
  await recordOperation("迁移", "", `从 ${SYNC_TABLE_NAME} 迁移 ${legacyNeeds.length} 条需求`, core.tableIds);
  return (await readCoreState()).state;
}

async function refreshLegacySnapshot(state) {
  const snapshot = snapshotPayload(state);
  const tableId = await ensureSyncTableId();
  const record = await getSyncRecord(tableId);
  if (record?.record_id) {
    await updateSyncRecord(tableId, record.record_id, snapshot.json);
  } else {
    await createSyncRecord(tableId, snapshot.json);
  }
  return snapshot.compact;
}

async function tryRefreshLegacySnapshot(state) {
  try {
    const compact = await refreshLegacySnapshot(state);
    return compact ? "旧版 JSON 镜像已改为安全摘要，完整明细已保存在核心表。" : "";
  } catch (error) {
    return `旧版 JSON 镜像未更新：${error.message || "未知错误"}`;
  }
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
  if (hotel === "汉庭酒店" || hotel === "汉庭") return "诺富特";
  if (hotel === "如家酒店" || hotel === "如家") return "宜必思";
  if (hotel === "万豪酒店" || hotel === "万豪") return "施柏阁";
  if (hotel === "诺富特酒店") return "诺富特";
  if (hotel === "宜必思酒店") return "宜必思";
  if (hotel === "施柏阁酒店") return "施柏阁";
  if (hotel === "大观酒店") return "大观";
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
  return need.checkIn && need.checkOut && date >= need.checkIn && date < need.checkOut;
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
        "备注": need.note || "",
        "上传批次": need.uploadBatchId || need.uploadBatchName || ""
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
      fields: ["序号", "姓名", "性别", "电话", "身份证号", "人员性质", "入住日期", "离店日期", "入住天数", "安排酒店", "房间号", "房间类型", "备注", "上传批次"],
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

function shouldCheckStateVersion(body) {
  return Boolean(body?.baseVersion) && ["upsertNeed", "upsertNeeds", "deleteNeed", "deleteNeeds"].includes(body?.action);
}

function shouldCreateOperationBackup(body) {
  return ["upsertNeeds", "deleteNeed", "deleteNeeds"].includes(body?.action);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (!["GET", "PUT", "POST"].includes(req.method)) return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    if (req.method === "GET") {
      const state = await migrateLegacyStateIfNeeded();
      await tryDailyBackup(state, null, "打开网站时自动备份");
      return json(res, 200, { ok: true, state, version: stateVersion(state), source: "core_tables" });
    }

    const body = await readJsonBody(req);
    const tableIds = await ensureCoreTableIds();
    const deferMirror = body?.deferMirror === true;
    const shouldSyncReadableViews = body?.action === "refreshViews";
    let cleanupResult = null;
    let legacySnapshotWarning = "";
    let beforeWrite = null;
    const readBeforeWrite = async () => {
      if (!beforeWrite) beforeWrite = await readCoreState(tableIds);
      return beforeWrite;
    };

    if (shouldCheckStateVersion(body)) {
      const current = await readBeforeWrite();
      if (current.version !== body.baseVersion) {
        return json(res, 409, {
          ok: false,
          stale: true,
          error: "共享数据已被其他人更新。为避免覆盖，请刷新后再操作。",
          state: current.state,
          version: current.version,
          source: "core_tables"
        });
      }
    }

    if (shouldCreateOperationBackup(body)) {
      const current = await readBeforeWrite();
      await createOperationBackup(current.state, tableIds, {
        operation: body.operationType || body.action || "",
        batchId: body.batchId || "",
        reason: body.operationDescription || "高风险操作前自动备份"
      });
    }

    if (body?.action === "upsertNeed") {
      await upsertNeedCore(body.need, tableIds);
      if (!deferMirror) {
        await recordOperation(
          body.operationType || "保存需求",
          body.need?.id || "",
          body.operationDescription || "网站保存单条入住需求",
          tableIds,
          { batchId: body.batchId || body.need?.uploadBatchId || "", count: 1 }
        );
      }
    } else if (body?.action === "upsertNeeds") {
      const needs = Array.isArray(body.needs) ? body.needs : [];
      const uploadTime = body.uploadBatchTime || nowIso();
      const needsWithBatch = needs.map((need) => ({
        ...need,
        uploadBatchId: need.uploadBatchId || body.batchId || "",
        uploadBatchName: need.uploadBatchName || body.batchName || body.batchId || "",
        uploadBatchTime: need.uploadBatchTime || uploadTime
      }));
      const result = await upsertNeedsCore(needsWithBatch, tableIds);
      if (deferMirror) {
        if (body.operationType) {
          await recordOperation(
            body.operationType,
            "",
            body.operationDescription || `网站批量保存 ${result.savedNeeds} 条入住需求，${result.savedPeople} 人`,
            tableIds,
            { batchId: body.batchId || "", count: result.savedNeeds }
          );
        }
        return json(res, 200, { ok: true, savedCount: result.savedNeeds, savedPeople: result.savedPeople, deferred: true });
      }
      await recordOperation(
        body.operationType || "批量保存需求",
        "",
        body.operationDescription || `网站批量保存 ${result.savedNeeds} 条入住需求，${result.savedPeople} 人`,
        tableIds,
        { batchId: body.batchId || "", count: result.savedNeeds }
      );
    } else if (body?.action === "deleteNeed") {
      await deleteNeedCore(body.needId, tableIds);
      if (!deferMirror) {
        await recordOperation(
          body.operationType || "删除需求",
          body.needId || "",
          body.operationDescription || "网站删除入住需求",
          tableIds,
          { batchId: body.batchId || "", count: 1 }
        );
      }
    } else if (body?.action === "deleteNeeds") {
      const needIds = Array.isArray(body.needIds) ? body.needIds : [];
      await deleteNeedsCore(needIds, tableIds);
      if (deferMirror) {
        if (body.operationType) {
          await recordOperation(
            body.operationType,
            "",
            body.operationDescription || `网站批量删除 ${needIds.length} 条入住需求`,
            tableIds,
            { batchId: body.batchId || "", count: needIds.length }
          );
        }
        return json(res, 200, { ok: true, deletedCount: needIds.length, deferred: true });
      }
      await recordOperation(
        body.operationType || "批量删除需求",
        "",
        body.operationDescription || `网站批量删除 ${needIds.length} 条入住需求`,
        tableIds,
        { batchId: body.batchId || "", count: needIds.length }
      );
    } else if (body?.action === "cleanupDuplicates") {
      cleanupResult = await cleanupDuplicateCoreRecords(tableIds);
      const { state, version } = await readCoreState(tableIds);
      legacySnapshotWarning = await tryRefreshLegacySnapshot(state);
      await tryDailyBackup(state, tableIds, "清理重复数据后自动备份");
      return json(res, 200, { ok: true, state, version, source: "core_tables", cleanup: cleanupResult, legacySnapshotWarning });
    } else if (body?.action === "refreshViews") {
      cleanupResult = await cleanupDuplicateCoreRecords(tableIds);
      await recordOperation("刷新展示", "", "网站刷新住宿展示数据", tableIds);
    } else if (body?.state && typeof body.state === "object") {
      const needs = Array.isArray(body.state.needs) ? body.state.needs : [];
      await upsertNeedsCore(needs, tableIds);
      await recordOperation("兼容保存", "", `兼容旧接口保存 ${needs.length} 条入住需求`, tableIds);
    } else {
      return json(res, 400, { ok: false, error: "缺少可保存的数据。" });
    }

    const { state, version } = await readCoreState(tableIds);
    legacySnapshotWarning = await tryRefreshLegacySnapshot(state);
    await tryDailyBackup(state, tableIds, "保存数据后自动备份");
    let mirrorError = "";
    if (shouldSyncReadableViews) {
      try {
        await syncReadableMirrorTables(state);
      } catch (error) {
        mirrorError = error.message || "飞书查看表同步失败";
      }
    }
    return json(res, 200, { ok: true, state, version, source: "core_tables", mirrorError, cleanup: cleanupResult, legacySnapshotWarning });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "同步失败" });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
