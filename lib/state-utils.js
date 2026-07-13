const crypto = require("crypto");
const zlib = require("zlib");

const ARRANGEMENT_HOTELS = ["诺富特", "宜必思", "施柏阁", "大观"];
const IDENTITY_OPTIONS = ["工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"];
const ROOM_TYPE_OPTIONS = ["双标", "大床", "套房", "其他"];
const GENDER_OPTIONS = ["", "男", "女"];
const MAX_NEEDS_PER_REQUEST = 1000;
const MAX_PEOPLE_PER_NEED = 50;
const BACKUP_CHUNK_CHARS = 70 * 1024;

class ValidationError extends Error {
  constructor(message, status = 400, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.code = code;
    this.stale = false;
    this.retryAfter = 0;
  }
}

function normalizedHotel(value) {
  const hotel = String(value || "").trim();
  if (hotel === "汉庭" || hotel === "汉庭酒店") return "诺富特";
  if (hotel === "如家" || hotel === "如家酒店") return "宜必思";
  if (hotel === "万豪" || hotel === "万豪酒店") return "施柏阁";
  if (hotel === "诺富特酒店") return "诺富特";
  if (hotel === "宜必思酒店") return "宜必思";
  if (hotel === "施柏阁酒店") return "施柏阁";
  if (hotel === "大观酒店") return "大观";
  return hotel;
}

function limitedText(value, label, maxLength, options = {}) {
  const text = String(value ?? "").trim();
  if (options.allowEmpty === false && !text) throw new ValidationError(`${label}不能为空。`);
  if (text.length > maxLength) throw new ValidationError(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

function validDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateStayDates(checkIn, checkOut, label) {
  if (!checkIn && !checkOut) return;
  if (!checkIn || !checkOut) throw new ValidationError(`${label}的入住日期和离店日期必须同时填写或同时留空。`);
  if (!validDate(checkIn) || !validDate(checkOut)) throw new ValidationError(`${label}的日期格式无效。`);
  if (checkOut <= checkIn) throw new ValidationError(`${label}的离店日期必须晚于入住日期。`);
}

function sanitizePerson(person, fallbackIdentity, label) {
  if (!person || typeof person !== "object" || Array.isArray(person)) {
    throw new ValidationError(`${label}格式无效。`);
  }
  const identity = limitedText(person.identity || fallbackIdentity || "其他", `${label}人员性质`, 20);
  if (!IDENTITY_OPTIONS.includes(identity)) throw new ValidationError(`${label}人员性质“${identity}”不在可选范围内。`);
  const gender = limitedText(person.gender, `${label}性别`, 10);
  if (!GENDER_OPTIONS.includes(gender)) throw new ValidationError(`${label}性别只能为男、女或留空。`);
  return {
    personId: limitedText(person.personId, `${label}人员ID`, 120),
    name: limitedText(person.name, `${label}姓名`, 120, { allowEmpty: false }),
    gender,
    phone: limitedText(person.phone, `${label}电话`, 80),
    idNo: limitedText(person.idNo, `${label}身份证号`, 100),
    identity
  };
}

function sanitizeNeed(need, index) {
  const label = `第 ${index + 1} 条需求`;
  if (!need || typeof need !== "object" || Array.isArray(need)) throw new ValidationError(`${label}格式无效。`);
  const id = limitedText(need.id, `${label}ID`, 120, { allowEmpty: false });
  const identity = limitedText(need.identity || "其他", `${label}人员性质`, 20);
  if (!IDENTITY_OPTIONS.includes(identity)) throw new ValidationError(`${label}人员性质“${identity}”不在可选范围内。`);
  const companions = Array.isArray(need.companions) ? need.companions : [];
  if (companions.length + 1 > MAX_PEOPLE_PER_NEED) {
    throw new ValidationError(`${label}最多允许 ${MAX_PEOPLE_PER_NEED} 人。`);
  }
  const mainPerson = sanitizePerson(need, identity, `${label}第 1 人`);
  const sanitizedCompanions = companions.map((person, personIndex) => (
    sanitizePerson(person, identity, `${label}第 ${personIndex + 2} 人`)
  ));
  const personIds = [mainPerson, ...sanitizedCompanions].map((person) => person.personId).filter(Boolean);
  if (new Set(personIds).size !== personIds.length) throw new ValidationError(`${label}存在重复人员ID。`);

  const hotel = normalizedHotel(limitedText(need.hotel, `${label}安排酒店`, 80));
  if (hotel && !ARRANGEMENT_HOTELS.includes(hotel)) throw new ValidationError(`${label}安排酒店“${hotel}”不在可选范围内。`);
  const roomType = limitedText(need.roomType, `${label}房间类型`, 40);
  if (roomType && !ROOM_TYPE_OPTIONS.includes(roomType)) throw new ValidationError(`${label}房间类型“${roomType}”不在可选范围内。`);
  const checkIn = limitedText(need.checkIn, `${label}入住日期`, 10);
  const checkOut = limitedText(need.checkOut, `${label}离店日期`, 10);
  validateStayDates(checkIn, checkOut, label);

  return {
    ...need,
    id,
    ...mainPerson,
    identity: mainPerson.identity,
    companions: sanitizedCompanions,
    hotel,
    roomNo: limitedText(need.roomNo, `${label}房间号`, 80),
    roomType,
    checkIn,
    checkOut,
    note: limitedText(need.note, `${label}备注`, 1000),
    uploadBatchId: limitedText(need.uploadBatchId, `${label}上传批次`, 120),
    uploadBatchName: limitedText(need.uploadBatchName, `${label}上传批次名称`, 200),
    uploadBatchTime: limitedText(need.uploadBatchTime, `${label}上传时间`, 40),
    cabin: limitedText(need.cabin, `${label}舱位`, 80),
    outboundFlight: limitedText(need.outboundFlight, `${label}去程航班`, 300),
    returnFlight: limitedText(need.returnFlight, `${label}返程航班`, 300)
  };
}

function validateNeedsPayload(needs) {
  if (!Array.isArray(needs)) throw new ValidationError("住宿需求必须为数组。", 400);
  if (needs.length > MAX_NEEDS_PER_REQUEST) {
    throw new ValidationError(`单次最多保存 ${MAX_NEEDS_PER_REQUEST} 条住宿需求。`, 413, "TOO_MANY_NEEDS");
  }
  const sanitized = needs.map(sanitizeNeed);
  const ids = sanitized.map((need) => need.id);
  if (new Set(ids).size !== ids.length) throw new ValidationError("本次提交存在重复需求ID，请检查后重新提交。", 409, "DUPLICATE_NEED_ID");
  return sanitized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function comparableNeed(need) {
  const companions = Array.isArray(need?.companions) ? need.companions : [];
  return stableValue({
    id: need?.id || "",
    name: need?.name || "",
    gender: need?.gender || "",
    phone: need?.phone || "",
    idNo: need?.idNo || "",
    identity: need?.identity || "其他",
    companions,
    checkIn: need?.checkIn || "",
    checkOut: need?.checkOut || "",
    hotel: normalizedHotel(need?.hotel),
    roomNo: need?.roomNo || "",
    roomType: need?.roomType || "",
    note: need?.note || "",
    cabin: need?.cabin || "",
    outboundFlight: need?.outboundFlight || "",
    returnFlight: need?.returnFlight || ""
  });
}

function needsEqual(left, right) {
  return stableStringify(comparableNeed(left)) === stableStringify(comparableNeed(right));
}

function canonicalStateVersion(state) {
  const needs = (Array.isArray(state?.needs) ? state.needs : [])
    .map(comparableNeed)
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "zh-CN"));
  const eventDates = Array.from(new Set(Array.isArray(state?.eventDates) ? state.eventDates : [])).sort();
  return crypto.createHash("sha256").update(stableStringify({ needs, eventDates })).digest("hex");
}

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeStateBackup(state) {
  const json = stableStringify(state);
  const compressed = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64");
  const chunks = [];
  for (let index = 0; index < compressed.length; index += BACKUP_CHUNK_CHARS) {
    chunks.push(compressed.slice(index, index + BACKUP_CHUNK_CHARS));
  }
  return {
    format: "gzip-base64-v1",
    checksum: checksum(json),
    originalBytes: Buffer.byteLength(json, "utf8"),
    chunks: chunks.length ? chunks : [""]
  };
}

function decodeStateBackup({ format, checksum: expectedChecksum, chunks }) {
  if (format !== "gzip-base64-v1") throw new Error(`不支持的备份格式：${format || "未知"}`);
  const compressed = (chunks || []).join("");
  const json = zlib.gunzipSync(Buffer.from(compressed, "base64")).toString("utf8");
  if (expectedChecksum && checksum(json) !== expectedChecksum) throw new Error("备份校验失败，分片可能缺失或损坏。");
  return JSON.parse(json);
}

function primaryNeedIdentity(need) {
  return need?.identity || "其他";
}

function uuidFromSeed(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed || crypto.randomUUID())).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = {
  ARRANGEMENT_HOTELS,
  BACKUP_CHUNK_CHARS,
  IDENTITY_OPTIONS,
  MAX_NEEDS_PER_REQUEST,
  ROOM_TYPE_OPTIONS,
  ValidationError,
  canonicalStateVersion,
  comparableNeed,
  decodeStateBackup,
  encodeStateBackup,
  needsEqual,
  normalizedHotel,
  primaryNeedIdentity,
  sanitizeNeed,
  stableStringify,
  uuidFromSeed,
  validateNeedsPayload,
  validateStayDates
};
