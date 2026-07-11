const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { _internal } = require("../api/state");
const {
  ValidationError,
  canonicalStateVersion,
  decodeStateBackup,
  encodeStateBackup,
  validateNeedsPayload
} = require("../lib/state-utils");

function need(overrides = {}) {
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

function coreRecord(value, recordId = "rec-1") {
  const json = JSON.stringify(value);
  return {
    record_id: recordId,
    fields: {
      "需求ID": value.id,
      "入住日期": value.checkIn,
      "离店日期": value.checkOut,
      "安排酒店": value.hotel,
      "房间号": value.roomNo,
      "房间类型": value.roomType,
      "备注": value.note,
      "需求JSON": json,
      "更新时间": "2026-07-11T00:00:00.000Z",
      "是否删除": "否"
    }
  };
}

function testValidation() {
  const withoutDates = validateNeedsPayload([need({ checkIn: "", checkOut: "" })]);
  assert.equal(withoutDates[0].checkIn, "");
  assert.throws(() => validateNeedsPayload([need({ checkOut: "" })]), ValidationError);
  assert.throws(() => validateNeedsPayload([need(), need({ name: "李四" })]), /重复需求ID/);
  assert.throws(() => validateNeedsPayload([need({ hotel: "不存在酒店" })]), /不在可选范围/);
}

function testStableVersion() {
  const first = need();
  const second = need({ id: "REQ-002", name: "李四" });
  assert.equal(
    canonicalStateVersion({ needs: [first, second], eventDates: ["2026-08-02", "2026-08-01"] }),
    canonicalStateVersion({ needs: [second, first], eventDates: ["2026-08-01", "2026-08-02"] })
  );
}

function testBackupRoundTrip() {
  const needs = Array.from({ length: 180 }, (_, index) => need({
    id: `REQ-${String(index + 1).padStart(4, "0")}`,
    name: `人员${index + 1}`,
    note: crypto.randomBytes(700).toString("base64")
  }));
  const state = { needs, eventDates: ["2026-08-01", "2026-08-02"] };
  const encoded = encodeStateBackup(state);
  assert.ok(encoded.originalBytes > 90 * 1024);
  const decoded = decodeStateBackup(encoded);
  assert.deepEqual(decoded, state);
  assert.equal(decoded.needs.length, needs.length);

  const rows = _internal.backupRows(state, { id: "TEST-BACKUP", type: "测试备份" });
  const records = rows.map((fields, index) => ({ record_id: `rec-${index}`, fields }));
  assert.deepEqual(_internal.backupStateFromRecords(records, "TEST-BACKUP"), decoded);
  const damaged = records.slice(0, -1);
  if (records.length > 1) assert.throws(() => _internal.backupStateFromRecords(damaged, "TEST-BACKUP"), /分片不完整/);
}

function testJsonCoreIsAuthoritative() {
  const source = need({
    companions: [{ personId: "P-2", name: "李四", gender: "男", phone: "", idNo: "", identity: "嘉宾" }]
  });
  const state = _internal.stateFromCoreRecords([coreRecord(source)], []);
  assert.equal(state.needs.length, 1);
  assert.equal(state.needs[0].name, "张三");
  assert.equal(state.needs[0].companions.length, 1);
  assert.equal(state.needs[0].companions[0].name, "李四");
}

function testReplayAndStatistics() {
  const source = need({
    companions: [{ personId: "P-2", name: "李四", gender: "男", phone: "", idNo: "", identity: "嘉宾" }]
  });
  const state = { needs: [source], eventDates: ["2026-08-01", "2026-08-02"] };
  assert.equal(_internal.mutationAlreadyApplied({ action: "upsertNeed", need: source }, state), true);
  assert.equal(_internal.mutationAlreadyApplied({ action: "deleteNeed", needId: "REQ-404" }, state), true);

  const people = _internal.personListRows(state);
  assert.deepEqual(people.map((row) => row["序号"]), [1, 1]);
  assert.notEqual(people[0]["名单键"], people[1]["名单键"]);

  const tables = _internal.readableMirrorTables(state);
  const roleRows = tables.find((table) => table.name === "角色统计查看").rows;
  assert.ok(roleRows.some((row) => row["人员性质"] === "工作人员"));
  assert.equal(roleRows.some((row) => row["人员性质"] === "嘉宾"), false);
}

function testRefreshStages() {
  assert.deepEqual(_internal.refreshViewStages, ["schema", "backup", "people", "personList", "hotelStats", "roleStats", "cleanup"]);
  assert.equal(_internal.nextRefreshStage("schema"), "backup");
  assert.equal(_internal.nextRefreshStage("cleanup"), "");
  assert.equal(_internal.validateMutationBody({ action: "refreshViews" }).stage, "schema");
  assert.throws(
    () => _internal.validateMutationBody({ action: "refreshViews", stage: "everything" }),
    /未知的查看表刷新步骤/
  );
}

function run() {
  testValidation();
  testStableVersion();
  testBackupRoundTrip();
  testJsonCoreIsAuthoritative();
  testReplayAndStatistics();
  testRefreshStages();
}

run();
