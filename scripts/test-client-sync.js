const assert = require("node:assert/strict");
const { analyzeNeedMerge, applyOperationToState } = require("../lib/client-sync-utils");

const base = { id: "REQ-1", name: "张三", phone: "130", hotel: "诺富特", roomNo: "101", companions: [] };
const local = { ...base, phone: "131" };
const remote = { ...base, roomNo: "102" };
const cleanMerge = analyzeNeedMerge(base, local, remote);
assert.deepEqual(cleanMerge.conflicts, []);
assert.equal(cleanMerge.merged.phone, "131");
assert.equal(cleanMerge.merged.roomNo, "102");

const conflicting = analyzeNeedMerge(base, { ...base, roomNo: "103" }, remote);
assert.deepEqual(conflicting.conflicts, ["roomNo"]);
assert.equal(conflicting.merged.roomNo, "103");

const replayed = applyOperationToState({ needs: [base] }, { action: "upsertNeed", need: local });
assert.equal(replayed.needs[0].phone, "131");
assert.equal(applyOperationToState(replayed, { action: "deleteNeed", needId: "REQ-1" }).needs.length, 0);
