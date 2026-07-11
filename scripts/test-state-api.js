const assert = require("node:assert/strict");

process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_APP_TOKEN = "test-base";

const tableDefinitions = [
  ["need", "住宿需求核心表"],
  ["person", "住宿人员明细表"],
  ["operation", "操作记录表"],
  ["backup", "每日备份表"],
  ["sync", "系统同步数据"]
];
const tables = tableDefinitions.map(([table_id, name]) => ({ table_id, name }));
const records = Object.fromEntries(tableDefinitions.map(([id]) => [id, []]));
const fields = Object.fromEntries(tableDefinitions.map(([id]) => [id, []]));
const idempotentCreates = new Map();
let recordSequence = 1;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERROR",
    async json() { return body; }
  };
}

function nextRecord(fieldsValue) {
  return { record_id: `rec-${recordSequence++}`, fields: fieldsValue };
}

function routeParts(pathname) {
  const match = pathname.match(/\/tables\/([^/]+)(?:\/(fields|records)(?:\/([^/]+))?(?:\/([^/]+))?)?/);
  return match ? { tableId: match[1], resource: match[2], id: match[3], action: match[4] } : {};
}

global.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = String(options.method || "GET").toUpperCase();
  const payload = options.body ? JSON.parse(options.body) : {};
  if (url.pathname.includes("tenant_access_token")) {
    return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
  }
  if (url.pathname.endsWith("/tables") && method === "GET") {
    return response({ code: 0, data: { items: tables, has_more: false } });
  }

  const { tableId, resource, id, action } = routeParts(url.pathname);
  if (!tableId || !records[tableId]) return response({ code: 1254041, msg: "Table not found" }, 404);
  if (resource === "fields" && method === "GET") {
    return response({ code: 0, data: { items: fields[tableId], has_more: false } });
  }
  if (resource === "fields" && method === "POST") {
    const field = { field_id: `fld-${fields[tableId].length + 1}`, field_name: payload.field_name, type: payload.type || 1 };
    fields[tableId].push(field);
    return response({ code: 0, data: { field } });
  }
  if (resource === "fields" && id && method === "PUT") {
    const field = fields[tableId].find((item) => item.field_id === id);
    if (field) Object.assign(field, { field_name: payload.field_name, type: payload.type });
    return response({ code: 0, data: { field } });
  }
  if (resource === "records" && method === "GET" && !id) {
    return response({ code: 0, data: { items: records[tableId], has_more: false } });
  }
  if (resource === "records" && id === "batch_create" && method === "POST") {
    const token = url.searchParams.get("client_token") || "";
    if (token && idempotentCreates.has(token)) return response({ code: 0, data: { records: idempotentCreates.get(token) } });
    const created = (payload.records || []).map((item) => nextRecord(item.fields || {}));
    records[tableId].push(...created);
    if (token) idempotentCreates.set(token, created);
    return response({ code: 0, data: { records: created } });
  }
  if (resource === "records" && id === "batch_update" && method === "POST") {
    for (const item of payload.records || []) {
      const record = records[tableId].find((candidate) => candidate.record_id === item.record_id);
      if (record) record.fields = item.fields;
    }
    return response({ code: 0, data: { records: payload.records || [] } });
  }
  if (resource === "records" && id === "batch_delete" && method === "POST") {
    const deleting = new Set(payload.records || []);
    records[tableId] = records[tableId].filter((record) => !deleting.has(record.record_id));
    return response({ code: 0, data: {} });
  }
  if (resource === "records" && id && method === "PUT") {
    const record = records[tableId].find((candidate) => candidate.record_id === id);
    if (!record) return response({ code: 1254006, msg: "Record not found" }, 404);
    record.fields = { ...record.fields, ...(payload.fields || {}) };
    return response({ code: 0, data: { record } });
  }
  if (resource === "records" && !id && method === "POST") {
    const token = url.searchParams.get("client_token") || "";
    if (token && idempotentCreates.has(token)) return response({ code: 0, data: { record: idempotentCreates.get(token)[0] } });
    const created = nextRecord(payload.fields || {});
    records[tableId].push(created);
    if (token) idempotentCreates.set(token, [created]);
    return response({ code: 0, data: { record: created } });
  }
  throw new Error(`未模拟的飞书请求：${method} ${url.pathname} ${JSON.stringify({ tableId, resource, id, action })}`);
};

const handler = require("../api/state");

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value) { this.body = value; }
  };
}

async function invoke(method, body) {
  const req = { method, body };
  const res = createResponse();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

function sampleNeed(overrides = {}) {
  return {
    id: "REQ-001",
    name: "张三",
    gender: "男",
    phone: "13000000000",
    idNo: "110101199001010011",
    identity: "工作人员",
    companions: [],
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    hotel: "诺富特",
    roomNo: "801",
    roomType: "双标",
    note: "",
    ...overrides
  };
}

async function run() {
  const firstGet = await invoke("GET");
  assert.equal(firstGet.status, 200);
  assert.equal(firstGet.body.state.needs.length, 0);
  assert.equal(firstGet.headers["cache-control"], "private, no-store, max-age=0");
  assert.equal(records.backup.length, 0, "读取接口不应写备份");

  const operationId = "TEST-UPSERT-1";
  const save = await invoke("PUT", {
    action: "upsertNeed",
    operationId,
    clientId: "TEST-CLIENT",
    baseVersion: firstGet.body.version,
    need: sampleNeed()
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.state.needs.length, 1);
  assert.equal(save.body.state.needs[0].name, "张三");
  assert.equal(records.need.length, 1);
  assert.equal(records.person.length, 1);
  assert.ok(records.backup.length >= 2, "应生成操作前备份和每日备份");

  const replay = await invoke("PUT", {
    action: "upsertNeed",
    operationId,
    clientId: "TEST-CLIENT",
    baseVersion: firstGet.body.version,
    need: sampleNeed()
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(records.need.length, 1, "幂等重试不应产生重复需求");
  assert.equal(records.person.length, 1, "幂等重试不应产生重复人员");

  const conflict = await invoke("PUT", {
    action: "upsertNeed",
    operationId: "TEST-CONFLICT",
    clientId: "TEST-CLIENT-2",
    baseVersion: firstGet.body.version,
    need: sampleNeed({ roomNo: "999" })
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.stale, true);
  assert.equal(conflict.body.state.needs[0].roomNo, "801");

  const secondGet = await invoke("GET");
  assert.equal(secondGet.status, 200);
  assert.equal(secondGet.body.state.needs.length, 1);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
