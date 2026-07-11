const crypto = require("crypto");
const {
  ValidationError,
  canonicalStateVersion,
  decodeStateBackup,
  encodeStateBackup,
  needsEqual,
  primaryNeedIdentity,
  stableStringify,
  uuidFromSeed,
  validateNeedsPayload
} = require("../lib/state-utils");

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
const REQUEST_BODY_MAX_BYTES = 2 * 1024 * 1024;
const MAINTENANCE_LOCK_ID = "SYSTEM-MAINTENANCE-LOCK";
const REFRESH_VIEW_STAGES = ["schema", "backup", "people", "personList", "hotelStats", "roleStats", "cleanup"];
const REFRESH_STAGE_TABLES = {
  personList: "住宿人员名单",
  hotelStats: "酒店统计查看",
  roleStats: "角色统计查看"
};

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
let readableSchemaReady = {};
let coreTableCache = {};
let coreSchemaReady = {};
let mutationChain = Promise.resolve();
let dailyBackupReadyDate = "";

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

async function fetchJsonWithRetry(url, options = {}, retryOptions = {}) {
  let lastError = null;
  const method = String(options.method || "GET").toUpperCase();
  const safeToRetry = retryOptions.idempotent === true || ["GET", "HEAD", "PUT", "DELETE"].includes(method);
  const attempts = safeToRetry ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      clearTimeout(timer);
      if (response.ok || !retryableResponse(response, body) || attempt === attempts - 1) {
        return { response, body };
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await sleep(retryDelay(attempt));
  }
  throw lastError || new Error("网络请求失败");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,PUT,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > REQUEST_BODY_MAX_BYTES) {
      throw new ValidationError("请求数据过大，请拆分后重试。", 413, "REQUEST_TOO_LARGE");
    }
    return req.body;
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > REQUEST_BODY_MAX_BYTES) throw new ValidationError("请求数据过大，请拆分后重试。", 413, "REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ValidationError("请求内容不是有效的 JSON。", 400, "INVALID_JSON");
  }
}

function logEvent(level, event, details = {}) {
  const payload = JSON.stringify({ timestamp: nowIso(), event, ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

function enqueueMutation(task) {
  const queued = mutationChain.catch(() => {}).then(task);
  mutationChain = queued.catch(() => {});
  return queued;
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

async function feishu(method, path, payload, options = {}) {
  const token = await tenantAccessToken();
  const { response, body } = await fetchJsonWithRetry(`${FEISHU_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: payload ? JSON.stringify(payload) : undefined
  }, options);
  if (!response.ok || body.code !== 0) {
    if (Number(body.code) === 1254291 || /write conflict|写冲突|并发/i.test(String(body.msg || ""))) {
      const conflict = new ValidationError("飞书检测到同时写入，请基于最新数据重试。", 409, "FEISHU_WRITE_CONFLICT");
      conflict.stale = true;
      throw conflict;
    }
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

async function ensureReadableTable(tableName, fields, knownTables = null) {
  if (readableTableCache[tableName]) {
    if (!readableSchemaReady[tableName]) {
      await ensureReadableFields(readableTableCache[tableName], fields);
      readableSchemaReady[tableName] = true;
    }
    return readableTableCache[tableName];
  }
  const tables = knownTables || await allTables();
  const existing = tables.find((table) => table.name === tableName);
  if (existing?.table_id) {
    readableTableCache[tableName] = existing.table_id;
    await ensureReadableFields(readableTableCache[tableName], fields);
    readableSchemaReady[tableName] = true;
    return readableTableCache[tableName];
  }

  const created = await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables`, {
    table: {
      name: tableName,
      default_view_name: "全部",
      fields: fields.map(fieldDefinition)
    }
  });
  readableTableCache[tableName] = created.table?.table_id || created.table_id;
  if (!readableTableCache[tableName]) throw new Error(`飞书查看表 ${tableName} 创建成功但没有返回 table_id。`);
  readableSchemaReady[tableName] = true;
  return readableTableCache[tableName];
}

function fieldDefinition(field) {
  if (typeof field === "string") return { field_name: field, type: 1 };
  return {
    field_name: field.name,
    type: field.type || 1,
    ...(field.property ? { property: field.property } : {})
  };
}

async function listFields(tableId) {
  return feishuItems(`/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields`, 100);
}

async function ensureReadableFields(tableId, fields) {
  const existingFields = await listFields(tableId);
  const existingByName = new Map(existingFields.map((field) => [field.field_name, field]));
  for (const field of fields) {
    const definition = fieldDefinition(field);
    const existing = existingByName.get(definition.field_name);
    if (!existing) {
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields`, {
        ...definition
      });
    } else if (definition.type === 2 && existing.type !== 2 && existing.field_id) {
      await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/fields/${existing.field_id}`, definition);
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
      delete readableSchemaReady[tableName];
    } catch {
      // 删除旧展示表失败不影响核心同步和新展示表刷新。
    }
  }
}

async function listRecords(tableId, options = {}) {
  const params = [];
  if (options.filter) params.push(`filter=${encodeURIComponent(options.filter)}`);
  if (options.sort) params.push(`sort=${encodeURIComponent(options.sort)}`);
  const suffix = params.length ? `?${params.join("&")}` : "";
  return feishuItems(`/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records${suffix}`, 500);
}

async function listActiveRecords(tableId) {
  return listRecords(tableId, { filter: 'CurrentValue.[是否删除]!="是"' });
}

function chunkArray(items, size = 100) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function batchCreateRecords(tableId, records, tokenSeed = crypto.randomUUID()) {
  const created = [];
  const chunks = chunkArray(records, 100);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (!chunk.length) continue;
    try {
      const clientToken = uuidFromSeed(`${tokenSeed}:${tableId}:batch-create:${chunkIndex}`);
      const data = await feishu(
        "POST",
        `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_create?client_token=${clientToken}`,
        { records: chunk },
        { idempotent: true }
      );
      created.push(...(data.records || []));
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      for (let recordIndex = 0; recordIndex < chunk.length; recordIndex += 1) {
        const record = chunk[recordIndex];
        const clientToken = uuidFromSeed(`${tokenSeed}:${tableId}:create:${chunkIndex}:${recordIndex}`);
        const data = await feishu(
          "POST",
          `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records?client_token=${clientToken}`,
          record,
          { idempotent: true }
        );
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
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_update`, { records: chunk }, { idempotent: true });
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      try {
        await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_update`, { records: chunk }, { idempotent: true });
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
      await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/batch_delete`, { records: chunk }, { idempotent: true });
    } catch (error) {
      if (!canRetryBatchMethod(error)) throw error;
      for (const recordId of chunk) {
        await feishu("DELETE", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records/${recordId}`);
      }
    }
  }
}

const NEED_FIELDS = ["需求ID", "入住日期", "离店日期", "安排酒店", "房间号", "房间类型", "备注", "上传批次", "上传时间", "创建时间", "更新时间", "是否删除", "需求JSON", "数据校验"];
const PERSON_FIELDS = ["人员ID", "需求ID", "顺序", "姓名", "性别", "电话", "身份证号", "人员性质", "是否主人员", "上传批次", "更新时间", "是否删除"];
const OPERATION_FIELDS = ["操作ID", "操作时间", "操作类型", "需求ID", "上传批次", "影响条数", "操作人", "请求ID", "客户端ID", "结果", "说明"];
const BACKUP_FIELDS = ["备份ID", "备份组ID", "备份类型", "备份日期", "备份时间", "关联操作", "上传批次", "需求数", "人数", "间夜", "分片序号", "分片总数", "数据格式", "数据校验", "原始字节数", "JSON内容", "说明"];

async function ensureCoreTableFromKnownTables(tableName, fields, tables, ensureSchema) {
  if (coreTableCache[tableName]) {
    if (ensureSchema && !coreSchemaReady[tableName]) {
      await ensureReadableFields(coreTableCache[tableName], fields);
      coreSchemaReady[tableName] = true;
    }
    return coreTableCache[tableName];
  }
  const existing = tables.find((table) => table.name === tableName);
  if (existing?.table_id) {
    coreTableCache[tableName] = existing.table_id;
    if (ensureSchema) {
      await ensureReadableFields(coreTableCache[tableName], fields);
      coreSchemaReady[tableName] = true;
    }
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
  coreSchemaReady[tableName] = true;
  return coreTableCache[tableName];
}

async function ensureCoreTableIds(options = {}) {
  const ensureSchema = options.ensureSchema !== false;
  const allCached = [NEED_TABLE_NAME, PERSON_TABLE_NAME, OPERATION_TABLE_NAME, BACKUP_TABLE_NAME]
    .every((name) => coreTableCache[name]);
  const tables = allCached ? [] : await allTables();
  const needTableId = await ensureCoreTableFromKnownTables(NEED_TABLE_NAME, NEED_FIELDS, tables, ensureSchema);
  const personTableId = await ensureCoreTableFromKnownTables(PERSON_TABLE_NAME, PERSON_FIELDS, tables, ensureSchema);
  const operationTableId = await ensureCoreTableFromKnownTables(OPERATION_TABLE_NAME, OPERATION_FIELDS, tables, ensureSchema);
  const backupTableId = await ensureCoreTableFromKnownTables(BACKUP_TABLE_NAME, BACKUP_FIELDS, tables, ensureSchema);
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
      duplicateRecordIds.add(duplicate.record_id);
    }
  }
  await batchDeleteRecords(tableId, Array.from(duplicateRecordIds));

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
    if (!key || !incomingKeys.has(key)) {
      deletes.push(record.record_id);
    }
  }
  await batchDeleteRecords(tableId, deletes);
  return {
    created: creates.length,
    updated: updates.length,
    deleted: deletes.length,
    duplicateDeleted: duplicateRecordIds.size
  };
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
  return canonicalStateVersion(state);
}

function coreKeyMap(records, keyField) {
  return new Map(activeUniqueRecords(records, keyField)
    .map((record) => [String(record.fields?.[keyField] || ""), record])
    .filter(([key]) => key));
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
  const needRecords = await listActiveRecords(needTableId);
  const personRecords = await listActiveRecords(personTableId);
  const deletedNeeds = await deleteDuplicateActiveRecords(needTableId, needRecords, "需求ID");
  const deletedPeople = await deleteDuplicateActiveRecords(personTableId, personRecords, "人员ID");
  return { deletedNeeds, deletedPeople };
}

function needCoreFields(need, existingFields = {}) {
  const updatedAt = nowIso();
  const uploadBatch = need.uploadBatchId || need.uploadBatchName || existingFields["上传批次"] || "";
  const uploadTime = need.uploadBatchTime || existingFields["上传时间"] || "";
  const needJson = stableStringify(need);
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
    "是否删除": "否",
    "需求JSON": needJson,
    "数据校验": crypto.createHash("sha256").update(needJson).digest("hex")
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
  const needRecords = await listActiveRecords(needTableId);
  const personRecords = await listActiveRecords(personTableId);
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

async function upsertNeedCore(need, tableIds, context = null, options = {}) {
  const [validNeed] = validateNeedsPayload([need]);
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const writeContext = context || await readCoreWriteContext(tableIds);
  const existingNeed = writeContext.needById.get(String(validNeed.id));
  const needFields = needCoreFields(validNeed, existingNeed?.fields || {});
  if (existingNeed?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records/${existingNeed.record_id}`, { fields: needFields });
    writeContext.needById.set(String(validNeed.id), { ...existingNeed, fields: needFields });
  } else {
    const clientToken = uuidFromSeed(`${options.operationId || validNeed.id}:need:create`);
    const created = await feishu(
      "POST",
      `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records?client_token=${clientToken}`,
      { fields: needFields },
      { idempotent: true }
    );
    writeContext.needById.set(String(validNeed.id), {
      record_id: created.record?.record_id || created.record_id || "",
      fields: needFields
    });
  }

  let personMirrorError = "";
  try {
    const personRows = needPeopleRows(validNeed);
    const existingPeople = writeContext.peopleByNeed.get(validNeed.id) || [];
    const existingPeopleById = coreKeyMap(existingPeople, "人员ID");
    const incomingPersonIds = new Set(personRows.map((row) => row["人员ID"]));
    for (let index = 0; index < personRows.length; index += 1) {
      const row = personRows[index];
      const existing = existingPeopleById.get(row["人员ID"]);
      if (existing?.record_id) {
        await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records/${existing.record_id}`, { fields: row });
        existing.fields = row;
      } else {
        const clientToken = uuidFromSeed(`${options.operationId || validNeed.id}:person:create:${index}`);
        const created = await feishu(
          "POST",
          `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records?client_token=${clientToken}`,
          { fields: row },
          { idempotent: true }
        );
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
    writeContext.peopleByNeed.set(validNeed.id, existingPeople);
  } catch (error) {
    personMirrorError = error.message || "人员明细镜像同步失败";
    logEvent("warn", "person_mirror_failed", { operationId: options.operationId || "", needId: validNeed.id, error: personMirrorError });
  }
  return { savedNeeds: 1, savedPeople: peopleForNeed(validNeed).length, personMirrorError };
}

async function upsertNeedsCore(needs, tableIds, context = null, options = {}) {
  const validNeeds = validateNeedsPayload(needs || []);
  if (!validNeeds.length) return { savedNeeds: 0, savedPeople: 0 };
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const writeContext = context || await readCoreWriteContext(tableIds);
  const needCreates = [];
  const needCreateIds = [];
  const needUpdates = [];
  const expectedChecksums = new Map();

  for (const need of validNeeds) {
    const existingNeed = writeContext.needById.get(String(need.id));
    const fields = needCoreFields(need, existingNeed?.fields || {});
    expectedChecksums.set(String(need.id), fields["数据校验"]);
    if (existingNeed?.record_id) {
      needUpdates.push({ record_id: existingNeed.record_id, fields });
      writeContext.needById.set(String(need.id), { ...existingNeed, fields });
    } else {
      needCreates.push({ fields });
      needCreateIds.push(String(need.id));
    }
  }

  await batchUpdateRecords(needTableId, needUpdates);
  const createdNeeds = await batchCreateRecords(needTableId, needCreates, `${options.operationId || "bulk"}:needs`);
  createdNeeds.forEach((record, index) => {
    const id = needCreateIds[index];
    if (!id) return;
    writeContext.needById.set(id, {
      record_id: record.record_id || "",
      fields: record.fields || needCreates[index]?.fields || {}
    });
  });

  const persistedNeeds = coreKeyMap(await listActiveRecords(needTableId), "需求ID");
  const failedNeedIds = validNeeds.map((need) => String(need.id)).filter((id) => {
    const record = persistedNeeds.get(id);
    return !record || record.fields?.["数据校验"] !== expectedChecksums.get(id);
  });
  if (failedNeedIds.length) {
    throw new Error(`核心需求保存校验失败，共 ${failedNeedIds.length} 条未完整写入，请使用同一批次重试。`);
  }

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

  let personMirrorError = "";
  try {
    await batchUpdateRecords(personTableId, personUpdates);
    await batchCreateRecords(personTableId, personCreates, `${options.operationId || "bulk"}:people`);
  } catch (error) {
    personMirrorError = error.message || "人员明细镜像同步失败";
    logEvent("warn", "person_mirror_failed", { operationId: options.operationId || "", affectedNeeds: validNeeds.length, error: personMirrorError });
  }
  return { savedNeeds: validNeeds.length, savedPeople, personMirrorError };
}

async function repairPersonCoreMirror(state, tableIds, operationId = `REPAIR-${Date.now()}`) {
  const validNeeds = validateNeedsPayload(state.needs || []);
  const { personTableId } = tableIds || await ensureCoreTableIds();
  const existingRecords = await listActiveRecords(personTableId);
  const existingById = coreKeyMap(existingRecords, "人员ID");
  const incomingRows = validNeeds.flatMap(needPeopleRows);
  const incomingIds = new Set(incomingRows.map((row) => row["人员ID"]));
  const updates = [];
  const creates = [];
  for (const row of incomingRows) {
    const existing = existingById.get(row["人员ID"]);
    if (existing?.record_id) updates.push({ record_id: existing.record_id, fields: row });
    else creates.push({ fields: row });
  }
  for (const record of existingRecords) {
    const personId = String(record.fields?.["人员ID"] || "");
    if (personId && !incomingIds.has(personId)) {
      updates.push({
        record_id: record.record_id,
        fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
    }
  }
  await batchUpdateRecords(personTableId, updates);
  await batchCreateRecords(personTableId, creates, `${operationId}:repair-people`);
  return { updated: updates.length, created: creates.length };
}

async function deleteNeedCore(needId, tableIds) {
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listActiveRecords(needTableId);
  const needRecord = coreKeyMap(needRecords, "需求ID").get(String(needId || ""));
  if (needRecord?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${needTableId}/records/${needRecord.record_id}`, {
      fields: { ...needRecord.fields, "更新时间": nowIso(), "是否删除": "是" }
    });
  }

  let personMirrorError = "";
  try {
    const personRecords = await listActiveRecords(personTableId);
    for (const record of personRecords.filter((item) => item.fields?.["需求ID"] === needId)) {
      await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${personTableId}/records/${record.record_id}`, {
        fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
      });
    }
  } catch (error) {
    personMirrorError = error.message || "人员明细镜像删除失败";
    logEvent("warn", "person_mirror_delete_failed", { needId: needId || "", error: personMirrorError });
  }
  return { deletedNeeds: needRecord?.record_id ? 1 : 0, personMirrorError };
}

async function deleteNeedsCore(needIds, tableIds) {
  const ids = new Set((needIds || []).map((id) => String(id || "")).filter(Boolean));
  if (!ids.size) return;
  const { needTableId, personTableId } = tableIds || await ensureCoreTableIds();
  const needRecords = await listActiveRecords(needTableId);
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

  await batchUpdateRecords(needTableId, needUpdates);
  let personMirrorError = "";
  try {
    const personRecords = await listActiveRecords(personTableId);
    const personUpdates = [];
    for (const record of personRecords) {
      const needId = String(record.fields?.["需求ID"] || "");
      if (ids.has(needId)) {
        personUpdates.push({
          record_id: record.record_id,
          fields: { ...record.fields, "更新时间": nowIso(), "是否删除": "是" }
        });
      }
    }
    await batchUpdateRecords(personTableId, personUpdates);
  } catch (error) {
    personMirrorError = error.message || "人员明细镜像删除失败";
    logEvent("warn", "person_mirror_delete_failed", { affectedNeeds: ids.size, error: personMirrorError });
  }
  return { deletedNeeds: needUpdates.length, personMirrorError };
}

async function recordOperation(type, needId, description, tableIds, options = {}) {
  const { operationTableId } = tableIds || await ensureCoreTableIds();
  const id = options.operationId || `OP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientToken = uuidFromSeed(`${id}:operation-log`);
  await feishu("POST", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${operationTableId}/records?client_token=${clientToken}`, {
    fields: {
      "操作ID": id,
      "操作时间": nowIso(),
      "操作类型": type,
      "需求ID": needId || "",
      "上传批次": options.batchId || "",
      "影响条数": String(options.count || ""),
      "操作人": options.operator || "网站",
      "请求ID": options.requestId || "",
      "客户端ID": options.clientId || "",
      "结果": options.result || "成功",
      "说明": description || ""
    }
  }, { idempotent: true });
}

async function maintenanceLockState(tableIds = null) {
  const { operationTableId } = tableIds || await ensureCoreTableIds({ ensureSchema: false });
  const records = await listRecords(operationTableId, { filter: `CurrentValue.[操作ID]="${MAINTENANCE_LOCK_ID}"` });
  const record = records.find((item) => item.fields?.["操作ID"] === MAINTENANCE_LOCK_ID);
  let details = {};
  try {
    details = JSON.parse(record?.fields?.["说明"] || "{}");
  } catch {
    details = {};
  }
  const locked = record?.fields?.["结果"] === "锁定" && Date.parse(details.expiresAt || "") > Date.now();
  return { locked, record, details };
}

async function setMaintenanceLock(locked, tableIds, options = {}) {
  const { operationTableId } = tableIds || await ensureCoreTableIds();
  const current = await maintenanceLockState({ operationTableId });
  const now = nowIso();
  const fields = {
    "操作ID": MAINTENANCE_LOCK_ID,
    "操作时间": now,
    "操作类型": "系统维护锁",
    "操作人": options.operator || "维护脚本",
    "结果": locked ? "锁定" : "解锁",
    "说明": JSON.stringify({
      reason: options.reason || "",
      lockedAt: now,
      expiresAt: locked ? new Date(Date.now() + (options.ttlMs || 30 * 60 * 1000)).toISOString() : now
    })
  };
  if (current.record?.record_id) {
    await feishu("PUT", `/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${operationTableId}/records/${current.record.record_id}`, { fields });
  } else {
    await batchCreateRecords(operationTableId, [{ fields }], `${MAINTENANCE_LOCK_ID}:create`);
  }
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

function backupRows(state, options = {}) {
  const date = options.date || todayKey();
  const summary = stateSummary(state);
  const encoded = encodeStateBackup(state);
  const groupId = options.id || `BACKUP-${date}-${Date.now()}`;
  return encoded.chunks.map((chunk, index) => ({
    "备份ID": `${groupId}#${String(index + 1).padStart(3, "0")}`,
    "备份组ID": groupId,
    "备份类型": options.type || "每日备份",
    "备份日期": date,
    "备份时间": nowIso(),
    "关联操作": options.operation || "",
    "上传批次": options.batchId || "",
    "需求数": String(summary.needCount),
    "人数": String(summary.peopleCount),
    "间夜": String(summary.nightCount),
    "分片序号": String(index + 1),
    "分片总数": String(encoded.chunks.length),
    "数据格式": encoded.format,
    "数据校验": encoded.checksum,
    "原始字节数": String(encoded.originalBytes),
    "JSON内容": chunk,
    "说明": options.reason || "网站自动完整备份"
  }));
}

function backupStateFromRecords(records, backupId) {
  const candidates = (records || []).filter((record) => {
    const fields = record.fields || {};
    return fields["备份组ID"] === backupId || fields["备份ID"] === backupId || String(fields["备份ID"] || "").startsWith(`${backupId}#`);
  });
  if (!candidates.length) throw new Error(`没有找到备份 ${backupId}。`);
  const firstFields = candidates[0].fields || {};
  if (!firstFields["数据格式"]) {
    const raw = firstFields["JSON内容"] || "";
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || !Array.isArray(parsed.needs)) throw new Error("该旧备份只包含摘要，无法恢复完整数据。");
    return parsed;
  }
  const sorted = candidates.sort((left, right) => Number(left.fields?.["分片序号"] || 0) - Number(right.fields?.["分片序号"] || 0));
  const total = Number(firstFields["分片总数"] || 0);
  if (!total || sorted.length !== total) throw new Error(`备份分片不完整，应有 ${total} 片，实际找到 ${sorted.length} 片。`);
  return decodeStateBackup({
    format: firstFields["数据格式"],
    checksum: firstFields["数据校验"],
    chunks: sorted.map((record) => record.fields?.["JSON内容"] || "")
  });
}

async function writeBackupGroup(state, tableIds, options = {}) {
  const { backupTableId } = tableIds || await ensureCoreTableIds();
  const rows = backupRows(state, options);
  const groupId = rows[0]["备份组ID"];
  const existingRecords = options.replaceExisting ? await listRecords(backupTableId) : [];
  const groupRecords = existingRecords.filter((record) => {
    const fields = record.fields || {};
    return fields["备份组ID"] === groupId || fields["备份ID"] === groupId || String(fields["备份ID"] || "").startsWith(`${groupId}#`);
  });
  const updates = [];
  const creates = [];
  rows.forEach((fields, index) => {
    const existing = groupRecords[index];
    if (existing?.record_id) updates.push({ record_id: existing.record_id, fields });
    else creates.push({ fields });
  });
  await batchUpdateRecords(backupTableId, updates);
  await batchCreateRecords(backupTableId, creates, `${groupId}:backup`);
  const obsolete = groupRecords.slice(rows.length).map((record) => record.record_id).filter(Boolean);
  await batchDeleteRecords(backupTableId, obsolete);
  return { groupId, chunks: rows.length };
}

async function upsertDailyBackup(state, tableIds, reason = "网站自动每日备份") {
  const date = todayKey();
  if (dailyBackupReadyDate === date) return { groupId: `DAILY-${date}`, skipped: true };
  const ids = tableIds || await ensureCoreTableIds();
  const existingRecords = await listRecords(ids.backupTableId);
  const exists = existingRecords.some((record) => {
    const fields = record.fields || {};
    const sameGroup = fields["备份组ID"] === `DAILY-${date}` || fields["备份ID"] === `DAILY-${date}` || String(fields["备份ID"] || "").startsWith(`DAILY-${date}#`);
    return sameGroup && fields["数据格式"] === "gzip-base64-v1";
  });
  if (exists) {
    dailyBackupReadyDate = date;
    return { groupId: `DAILY-${date}`, skipped: true };
  }
  const result = await writeBackupGroup(state, tableIds, {
    id: `DAILY-${date}`,
    type: "每日备份",
    date,
    reason,
    replaceExisting: true
  });
  dailyBackupReadyDate = date;
  return result;
}

async function createOperationBackup(state, tableIds, options = {}) {
  const date = todayKey();
  return writeBackupGroup(state, tableIds, {
    id: `BEFORE-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "操作前备份",
    date,
    operation: options.operation || "",
    batchId: options.batchId || "",
    reason: options.reason || "高风险操作前自动备份",
    replaceExisting: false
  });
}

async function tryDailyBackup(state, tableIds, reason) {
  try {
    await upsertDailyBackup(state, tableIds, reason);
  } catch (error) {
    logEvent("error", "daily_backup_failed", { error: error.message || "未知错误" });
  }
}

async function readBackupState(backupId, tableIds = null) {
  const ids = tableIds || await ensureCoreTableIds({ ensureSchema: false });
  const records = await listRecords(ids.backupTableId);
  return backupStateFromRecords(records, backupId);
}

async function restoreBackupById(backupId, options = {}) {
  if (!backupId) throw new Error("缺少备份组ID。");
  const tableIds = await ensureCoreTableIds();
  await setMaintenanceLock(true, tableIds, { operator: options.operator, reason: `恢复备份 ${backupId}` });
  try {
    await sleep(2000);
    const current = await readCoreState(tableIds);
    const restoredState = await readBackupState(backupId, tableIds);
    const restoredNeeds = validateNeedsPayload(restoredState.needs || []);
    await createOperationBackup(current.state, tableIds, {
      operation: "恢复备份",
      reason: `恢复 ${backupId} 前自动备份`
    });
    const operationId = options.operationId || `RESTORE-${Date.now()}`;
    await upsertNeedsCore(restoredNeeds, tableIds, null, { operationId });
    const restoredIds = new Set(restoredNeeds.map((need) => need.id));
    const obsoleteIds = (current.state.needs || []).map((need) => need.id).filter((id) => !restoredIds.has(id));
    await deleteNeedsCore(obsoleteIds, tableIds);
    await recordOperation("恢复备份", "", `已从 ${backupId} 恢复 ${restoredNeeds.length} 条需求`, tableIds, {
      operationId,
      count: restoredNeeds.length,
      operator: options.operator || "本地恢复脚本"
    });
    return await readCoreState(tableIds);
  } finally {
    await setMaintenanceLock(false, tableIds, { operator: options.operator, reason: `恢复备份 ${backupId} 完成` });
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
    const storedJson = fields["需求JSON"] || "";
    if (storedJson) {
      try {
        const expectedChecksum = fields["数据校验"] || "";
        const actualChecksum = crypto.createHash("sha256").update(storedJson).digest("hex");
        if (expectedChecksum && expectedChecksum !== actualChecksum) throw new Error("需求JSON校验失败");
        const storedNeed = JSON.parse(storedJson);
        const companions = Array.isArray(storedNeed.companions) ? storedNeed.companions : [];
        return {
          ...storedNeed,
          id: fields["需求ID"] || storedNeed.id || "",
          companions,
          people: Math.max(1, companions.length + 1),
          adults: Math.max(1, companions.length + 1),
          children: 0,
          checkIn: fields["入住日期"] || storedNeed.checkIn || "",
          checkOut: fields["离店日期"] || storedNeed.checkOut || "",
          hotel: normalizedNeedHotel(fields["安排酒店"] || storedNeed.hotel),
          roomNo: fields["房间号"] || storedNeed.roomNo || "",
          roomType: fields["房间类型"] || storedNeed.roomType || "",
          note: fields["备注"] || storedNeed.note || "",
          uploadBatchId: fields["上传批次"] || storedNeed.uploadBatchId || "",
          uploadBatchName: fields["上传批次"] || storedNeed.uploadBatchName || "",
          uploadBatchTime: fields["上传时间"] || storedNeed.uploadBatchTime || fields["创建时间"] || storedNeed.createdAt || ""
        };
      } catch (error) {
        logEvent("warn", "need_json_invalid", { needId: fields["需求ID"] || "", error: error.message || "JSON解析失败" });
      }
    }
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
      uploadBatchTime: fields["上传时间"] || fields["创建时间"] || "",
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
  const ids = tableIds || await ensureCoreTableIds({ ensureSchema: false });
  const needRecords = await listActiveRecords(ids.needTableId);
  const jsonReady = activeUniqueRecords(needRecords, "需求ID").every((record) => {
    try {
      const value = JSON.parse(record.fields?.["需求JSON"] || "");
      return value && value.id === record.fields?.["需求ID"];
    } catch {
      return false;
    }
  });
  const personRecords = jsonReady ? [] : await listActiveRecords(ids.personTableId);
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
  return primaryNeedIdentity(need) === identity;
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
    "双标": counts["双标"],
    "大床": counts["大床"],
    "套房": counts["套房"],
    "其他": counts["其他"],
    "合计": total
  };
}

function personListRows(state) {
  const rows = [];
  (state.needs || []).forEach((need, needIndex) => {
    peopleForNeed(need).forEach((person, personIndex) => {
      rows.push({
        "名单键": `${need.id || needIndex + 1}｜${person.personId || personIndex + 1}`,
        "序号": needIndex + 1,
        "姓名": person.name || "",
        "性别": person.gender || "",
        "电话": person.phone || "",
        "身份证号": person.idNo || "",
        "人员性质": personIdentity(person, need.identity),
        "入住日期": need.checkIn || "",
        "离店日期": need.checkOut || "",
        "入住天数": stayDayCount(need),
        "安排酒店": normalizedNeedHotel(need.hotel),
        "房间号": need.roomNo || "",
        "房间类型": need.roomType || "",
        "备注": need.note || "",
        "上传批次": need.uploadBatchId || need.uploadBatchName || ""
      });
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
      keyField: "名单键",
      fields: ["名单键", { name: "序号", type: 2, property: { formatter: "0" } }, "姓名", "性别", "电话", "身份证号", "人员性质", "入住日期", "离店日期", { name: "入住天数", type: 2, property: { formatter: "0" } }, "安排酒店", "房间号", "房间类型", "备注", "上传批次"],
      rows: personListRows(state)
    },
    {
      name: "酒店统计查看",
      keyField: "统计维度",
      fields: ["统计维度", "日期", "酒店", "人员性质", ...["双标", "大床", "套房", "其他", "合计"].map((name) => ({ name, type: 2, property: { formatter: "0" } }))],
      rows: hotelStatRows(state)
    },
    {
      name: "角色统计查看",
      keyField: "统计维度",
      fields: ["统计维度", "日期", "人员性质", "酒店", ...["双标", "大床", "套房", "其他", "合计"].map((name) => ({ name, type: 2, property: { formatter: "0" } }))],
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

async function ensureReadableMirrorSchemas(state) {
  const tables = readableMirrorTables(state);
  const knownTables = await allTables();
  for (const table of tables) {
    await ensureReadableTable(table.name, table.fields, knownTables);
  }
  return { tables: tables.map((table) => table.name) };
}

async function syncReadableMirrorStage(state, stage) {
  const tableName = REFRESH_STAGE_TABLES[stage];
  if (!tableName) throw new ValidationError(`未知的查看表刷新步骤：${stage}。`);
  const table = readableMirrorTables(state).find((item) => item.name === tableName);
  if (!table) throw new Error(`没有找到查看表定义：${tableName}。`);
  const tableId = await ensureReadableTable(table.name, table.fields);
  const result = await upsertReadableRecords(tableId, table.keyField, table.rows);
  return { table: table.name, rows: table.rows.length, ...result };
}

function nextRefreshStage(stage) {
  const index = REFRESH_VIEW_STAGES.indexOf(stage);
  return index >= 0 && index < REFRESH_VIEW_STAGES.length - 1 ? REFRESH_VIEW_STAGES[index + 1] : "";
}

async function createMaintenanceBackup(state, version, tableIds, operationId) {
  const digest = crypto.createHash("sha256").update(`${operationId}:${version}`).digest("hex").slice(0, 16);
  return writeBackupGroup(state, tableIds, {
    id: `MANUAL-${todayKey()}-${digest}`,
    type: "手动完整备份",
    date: todayKey(),
    operation: "维护刷新前备份",
    reason: "查看表维护前生成的可恢复完整备份",
    replaceExisting: true
  });
}

function shouldCheckStateVersion(body) {
  return ["upsertNeed", "upsertNeeds", "deleteNeed", "deleteNeeds", "cleanupDuplicates"].includes(body?.action) ||
    (body?.action === "refreshViews" && body?.stage === "backup") ||
    Boolean(body?.state);
}

function shouldCreateOperationBackup(body) {
  return ["upsertNeed", "upsertNeeds", "deleteNeed", "deleteNeeds", "cleanupDuplicates"].includes(body?.action) || Boolean(body?.state);
}

function mutationAlreadyApplied(body, state) {
  const currentNeeds = new Map((state.needs || []).map((need) => [need.id, need]));
  if (body?.action === "upsertNeed") {
    const current = currentNeeds.get(body.need?.id);
    return Boolean(current && needsEqual(current, body.need));
  }
  if (body?.action === "upsertNeeds") {
    return Array.isArray(body.needs) && body.needs.every((need) => {
      const current = currentNeeds.get(need.id);
      return Boolean(current && needsEqual(current, need));
    });
  }
  if (body?.action === "deleteNeed") return !currentNeeds.has(body.needId);
  if (body?.action === "deleteNeeds") return Array.isArray(body.needIds) && body.needIds.every((id) => !currentNeeds.has(id));
  if (body?.state && typeof body.state === "object") {
    const incoming = Array.isArray(body.state.needs) ? body.state.needs : [];
    return incoming.length === currentNeeds.size && incoming.every((need) => {
      const current = currentNeeds.get(need.id);
      return Boolean(current && needsEqual(current, need));
    });
  }
  return false;
}

function hasTargetBaseline(body) {
  return Object.prototype.hasOwnProperty.call(body || {}, "baseNeed") || Array.isArray(body?.baseNeeds);
}

function targetStateIsUnchanged(body, state) {
  const currentNeeds = new Map((state.needs || []).map((need) => [need.id, need]));
  if (body.action === "upsertNeed") {
    const current = currentNeeds.get(body.need.id) || null;
    if (current && needsEqual(current, body.need)) return true;
    return body.baseNeed ? Boolean(current && needsEqual(current, body.baseNeed)) : !current;
  }
  if (body.action === "deleteNeed") {
    const current = currentNeeds.get(body.needId) || null;
    if (!current) return true;
    return Boolean(body.baseNeed && needsEqual(current, body.baseNeed));
  }
  if (body.action === "upsertNeeds") {
    const baseById = new Map((body.baseNeeds || []).map((need) => [need.id, need]));
    return body.needs.every((need) => {
      const current = currentNeeds.get(need.id) || null;
      if (current && needsEqual(current, need)) return true;
      const base = baseById.get(need.id);
      return base ? Boolean(current && needsEqual(current, base)) : !current;
    });
  }
  if (body.action === "deleteNeeds") {
    const baseById = new Map((body.baseNeeds || []).map((need) => [need.id, need]));
    return body.needIds.every((id) => {
      const current = currentNeeds.get(id) || null;
      if (!current) return true;
      const base = baseById.get(id);
      return Boolean(base && needsEqual(current, base));
    });
  }
  return false;
}

function mutationHasConflict(body, current) {
  if (hasTargetBaseline(body) && ["upsertNeed", "upsertNeeds", "deleteNeed", "deleteNeeds"].includes(body.action)) {
    return !targetStateIsUnchanged(body, current.state);
  }
  return current.version !== body.baseVersion;
}

function validateMutationBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("请求数据格式无效。");
  const normalized = { ...body };
  normalized.operationId = String(body.operationId || crypto.randomUUID()).slice(0, 120);
  normalized.clientId = String(body.clientId || "").slice(0, 120);
  normalized.operator = String(body.operator || "").slice(0, 80);
  if (body.action === "upsertNeed") {
    normalized.need = validateNeedsPayload([body.need])[0];
    if (Object.prototype.hasOwnProperty.call(body, "baseNeed")) {
      normalized.baseNeed = body.baseNeed === null ? null : validateNeedsPayload([body.baseNeed])[0];
    }
  } else if (body.action === "upsertNeeds") {
    normalized.needs = validateNeedsPayload(body.needs || []);
    if (Array.isArray(body.baseNeeds)) normalized.baseNeeds = validateNeedsPayload(body.baseNeeds);
  } else if (body.action === "deleteNeed") {
    normalized.needId = String(body.needId || "").trim().slice(0, 120);
    if (!normalized.needId) throw new ValidationError("缺少需要删除的需求ID。");
    if (Object.prototype.hasOwnProperty.call(body, "baseNeed")) {
      normalized.baseNeed = body.baseNeed === null ? null : validateNeedsPayload([body.baseNeed])[0];
    }
  } else if (body.action === "deleteNeeds") {
    if (!Array.isArray(body.needIds) || body.needIds.length > 1000) throw new ValidationError("批量删除列表无效或超过 1000 条。", 413);
    normalized.needIds = Array.from(new Set(body.needIds.map((id) => String(id || "").trim()).filter(Boolean)));
    if (Array.isArray(body.baseNeeds)) normalized.baseNeeds = validateNeedsPayload(body.baseNeeds);
  } else if (body.action === "cleanupDuplicates") {
    // 维护动作没有业务数据负载。
  } else if (body.action === "refreshViews") {
    normalized.stage = String(body.stage || "schema");
    if (!REFRESH_VIEW_STAGES.includes(normalized.stage)) {
      throw new ValidationError(`未知的查看表刷新步骤：${normalized.stage}。`);
    }
  } else if (body.state && typeof body.state === "object") {
    normalized.state = { ...body.state, needs: validateNeedsPayload(body.state.needs || []) };
  } else {
    throw new ValidationError("缺少可保存的数据。");
  }
  return normalized;
}

function operationLogOptions(body, requestId, count) {
  return {
    operationId: body.operationId,
    batchId: body.batchId || "",
    count,
    operator: body.operator || "网站",
    requestId,
    clientId: body.clientId || "",
    result: "成功"
  };
}

async function processMutation(body, requestId) {
  const isRefreshViews = body.action === "refreshViews";
  const tableIds = await ensureCoreTableIds({ ensureSchema: !isRefreshViews || body.stage === "schema" });
  const maintenance = await maintenanceLockState(tableIds);
  if (maintenance.locked) {
    return { status: 423, body: { ok: false, error: "系统正在恢复备份，请稍后再试。", code: "MAINTENANCE_LOCKED" } };
  }
  const deferMirror = body.deferMirror === true;
  let cleanupResult = null;
  let maintenanceResult = null;
  let personMirrorError = "";
  let operationLogError = "";
  let legacySnapshotWarning = "";
  let beforeWrite = null;
  const readBeforeWrite = async () => {
    if (!beforeWrite) beforeWrite = await readCoreState(tableIds);
    return beforeWrite;
  };

  if (shouldCheckStateVersion(body)) {
    const current = await readBeforeWrite();
    if (!body.baseVersion) {
      return { status: 428, body: { ok: false, stale: true, error: "缺少数据版本，请刷新后重新操作。", state: current.state, version: current.version } };
    }
    if (mutationHasConflict(body, current)) {
      if (mutationAlreadyApplied(body, current.state)) {
        return { status: 200, body: { ok: true, replayed: true, state: current.state, version: current.version, source: "core_tables" } };
      }
      return {
        status: 409,
        body: {
          ok: false,
          stale: true,
          error: "共享数据已被其他人更新。你的修改已保留，请选择继续保存或采用线上数据。",
          state: current.state,
          version: current.version,
          source: "core_tables"
        }
      };
    }
  }

  if (shouldCreateOperationBackup(body)) {
    const current = await readBeforeWrite();
    await createOperationBackup(current.state, tableIds, {
      operation: body.operationType || body.action || "",
      batchId: body.batchId || "",
      reason: body.operationDescription || "数据修改前自动完整备份"
    });
    const latest = await readCoreState(tableIds);
    if (shouldCheckStateVersion(body) && mutationHasConflict(body, latest)) {
      if (mutationAlreadyApplied(body, latest.state)) {
        return { status: 200, body: { ok: true, replayed: true, state: latest.state, version: latest.version, source: "core_tables" } };
      }
      return {
        status: 409,
        body: {
          ok: false,
          stale: true,
          error: "备份期间共享数据发生了变化。你的修改已保留，请确认后重试。",
          state: latest.state,
          version: latest.version,
          source: "core_tables"
        }
      };
    }
  }

  const maintenanceBeforeWrite = await maintenanceLockState(tableIds);
  if (maintenanceBeforeWrite.locked) {
    return { status: 423, body: { ok: false, error: "系统正在恢复备份，请稍后再试。", code: "MAINTENANCE_LOCKED" } };
  }

  let logArgs = null;
  if (body.action === "upsertNeed") {
    const result = await upsertNeedCore(body.need, tableIds, null, { operationId: body.operationId });
    personMirrorError = result.personMirrorError || "";
    logArgs = [body.operationType || "保存需求", body.need.id, body.operationDescription || "网站保存单条入住需求", 1];
  } else if (body.action === "upsertNeeds") {
    const uploadTime = body.uploadBatchTime || nowIso();
    const needsWithBatch = body.needs.map((need) => ({
      ...need,
      uploadBatchId: need.uploadBatchId || body.batchId || "",
      uploadBatchName: need.uploadBatchName || body.batchName || body.batchId || "",
      uploadBatchTime: need.uploadBatchTime || uploadTime
    }));
    const result = await upsertNeedsCore(needsWithBatch, tableIds, null, { operationId: body.operationId });
    personMirrorError = result.personMirrorError || "";
    logArgs = [
      body.operationType || "批量保存需求",
      "",
      body.operationDescription || `网站批量保存 ${result.savedNeeds} 条入住需求，${result.savedPeople} 人`,
      result.savedNeeds
    ];
  } else if (body.action === "deleteNeed") {
    const result = await deleteNeedCore(body.needId, tableIds);
    personMirrorError = result.personMirrorError || "";
    logArgs = [body.operationType || "删除需求", body.needId, body.operationDescription || "网站删除入住需求", 1];
  } else if (body.action === "deleteNeeds") {
    const result = await deleteNeedsCore(body.needIds, tableIds);
    personMirrorError = result.personMirrorError || "";
    logArgs = [body.operationType || "批量删除需求", "", body.operationDescription || `网站批量删除 ${body.needIds.length} 条入住需求`, body.needIds.length];
  } else if (body.action === "cleanupDuplicates") {
    cleanupResult = await cleanupDuplicateCoreRecords(tableIds);
    logArgs = ["清理重复", "", `清理重复需求 ${cleanupResult.deletedNeeds} 条、重复人员 ${cleanupResult.deletedPeople} 条`, cleanupResult.deletedNeeds + cleanupResult.deletedPeople];
  } else if (body.action === "refreshViews") {
    const current = await readBeforeWrite();
    let result = {};
    if (body.stage === "schema") {
      result = await ensureReadableMirrorSchemas(current.state);
    } else if (body.stage === "backup") {
      result = await createMaintenanceBackup(current.state, current.version, tableIds, body.operationId);
    } else if (body.stage === "people") {
      result = await repairPersonCoreMirror(current.state, tableIds, body.operationId);
    } else if (REFRESH_STAGE_TABLES[body.stage]) {
      result = await syncReadableMirrorStage(current.state, body.stage);
    } else if (body.stage === "cleanup") {
      await deleteObsoleteReadableTables();
      legacySnapshotWarning = await tryRefreshLegacySnapshot(current.state);
      result = { cleaned: true };
    }
    maintenanceResult = {
      stage: body.stage,
      nextStage: nextRefreshStage(body.stage),
      complete: body.stage === REFRESH_VIEW_STAGES[REFRESH_VIEW_STAGES.length - 1],
      ...result
    };
    const affected = Number(result.rows || result.updated || result.created || 0);
    logArgs = ["分段刷新展示", "", `完成查看表维护步骤 ${body.stage}`, affected];
  } else if (body.state && typeof body.state === "object") {
    const current = await readBeforeWrite();
    const needs = body.state.needs || [];
    const result = await upsertNeedsCore(needs, tableIds, null, { operationId: body.operationId });
    personMirrorError = result.personMirrorError || "";
    const incomingIds = new Set(needs.map((need) => need.id));
    const obsoleteIds = (current.state.needs || []).map((need) => need.id).filter((id) => !incomingIds.has(id));
    if (obsoleteIds.length) await deleteNeedsCore(obsoleteIds, tableIds);
    logArgs = ["兼容保存", "", `兼容旧接口保存 ${needs.length} 条入住需求`, needs.length];
  }

  if (logArgs && (!deferMirror || body.operationType)) {
    try {
      await recordOperation(logArgs[0], logArgs[1], logArgs[2], tableIds, operationLogOptions(body, requestId, logArgs[3]));
    } catch (error) {
      operationLogError = error.message || "操作日志写入失败";
      logEvent("error", "operation_log_failed", { requestId, operationId: body.operationId, error: operationLogError });
    }
  }

  const finalCore = isRefreshViews && beforeWrite ? beforeWrite : await readCoreState(tableIds);
  const { state, version } = finalCore;
  if (shouldCreateOperationBackup(body)) await tryDailyBackup(state, tableIds, "当日首次修改后完整备份");
  let mirrorError = "";
  return {
    status: 200,
    body: {
      ok: true,
      state,
      version,
      source: "core_tables",
      deferred: deferMirror,
      mirrorError,
      personMirrorError,
      operationLogError,
      cleanup: cleanupResult,
      maintenance: maintenanceResult,
      legacySnapshotWarning
    }
  };
}

async function handler(req, res) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let requestAction = "";
  const respond = (status, body) => {
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "api_request", {
      requestId,
      method: req.method,
      action: requestAction,
      status,
      durationMs: Date.now() - startedAt,
      error: status >= 400 ? body?.error || "" : ""
    });
    return json(res, status, { ...body, requestId });
  };

  if (req.method === "OPTIONS") return respond(200, { ok: true });
  if (!["GET", "PUT", "POST"].includes(req.method)) return respond(405, { ok: false, error: "Method not allowed" });

  try {
    if (req.method === "GET") {
      const state = await migrateLegacyStateIfNeeded();
      return respond(200, { ok: true, state, version: stateVersion(state), source: "core_tables" });
    }

    const body = validateMutationBody(await readJsonBody(req));
    requestAction = body.action || (body.state ? "legacyStateSave" : "");
    const result = await enqueueMutation(() => processMutation(body, requestId));
    return respond(result.status, result.body);
  } catch (error) {
    const status = Number(error.status) || 500;
    logEvent("error", "api_failure", {
      requestId,
      method: req.method,
      status,
      code: error.code || "UNEXPECTED_ERROR",
      error: error.message || "同步失败",
      stack: status >= 500 ? String(error.stack || "").slice(0, 2000) : ""
    });
    if (status === 409 && error.stale) {
      try {
        const current = await readCoreState();
        return respond(409, {
          ok: false,
          stale: true,
          error: error.message || "检测到同时写入，请重试。",
          code: error.code || "FEISHU_WRITE_CONFLICT",
          state: current.state,
          version: current.version,
          source: "core_tables"
        });
      } catch (readError) {
        logEvent("error", "conflict_state_read_failed", { requestId, error: readError.message || "读取失败" });
      }
    }
    return respond(status, { ok: false, error: error.message || "同步失败", code: error.code || "UNEXPECTED_ERROR" });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
module.exports._internal = {
  backupRows,
  backupStateFromRecords,
  mutationAlreadyApplied,
  nextRefreshStage,
  personListRows,
  readableMirrorTables,
  refreshViewStages: REFRESH_VIEW_STAGES,
  restoreBackupById,
  stateFromCoreRecords,
  stateVersion,
  validateMutationBody
};
