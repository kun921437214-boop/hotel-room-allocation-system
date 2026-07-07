const storageKey = "hotelRoomOpsLocalSystem.v5.roomAvailability";
const syncApiUrl = window.HOTEL_ROOM_SYNC_API || "/api/state";

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

let state = loadState();
let activeView = "dashboard";
let editing = null;
let remoteSyncReady = false;
let saveTimer = null;
let saveInFlight = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function defaultDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dateToValue(date);
}

function activeDates() {
  const needDates = Array.from(new Set(state.needs.flatMap((need) => nightsBetween(need.checkIn, need.checkOut)))).sort();
  if (needDates.length) return needDates;
  const roomDates = Array.from(new Set(state.rooms.flatMap((room) => roomAvailableDates(room)))).sort();
  if (roomDates.length) return roomDates;
  return state.eventDates.length ? state.eventDates : [defaultDate()];
}

function roomAvailableDates(room) {
  if (room.availableFrom && room.availableTo && room.availableFrom < room.availableTo) {
    return nightsBetween(room.availableFrom, room.availableTo);
  }
  return [];
}

function isRoomAvailableOn(room, date) {
  return roomAvailableDates(room).includes(date);
}

function isRoomAvailableForStay(room, checkIn, checkOut) {
  const stayDates = nightsBetween(checkIn, checkOut);
  if (!stayDates.length) return false;
  return stayDates.every((date) => isRoomAvailableOn(room, date));
}

function addDatesToEventRange(dates) {
  dates.filter(Boolean).forEach((date) => {
    if (!state.eventDates.includes(date)) state.eventDates.push(date);
  });
  state.eventDates.sort();
}

function loadState() {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return structuredClone(sampleData);
  try {
    return JSON.parse(stored);
  } catch {
    return structuredClone(sampleData);
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
  scheduleRemoteSave();
}

function setSyncStatus(message, type = "") {
  const status = $("#syncStatus");
  if (!status) return;
  status.textContent = message;
  status.className = ["sync-status", type].filter(Boolean).join(" ");
}

function saveLocalStateOnly() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

async function loadRemoteState() {
  setSyncStatus("正在连接共享数据");
  try {
    const response = await fetch(syncApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.state) {
      state = payload.state;
      saveLocalStateOnly();
    }
    remoteSyncReady = true;
    setSyncStatus("共享数据已同步", "ok");
    return true;
  } catch (error) {
    remoteSyncReady = false;
    setSyncStatus("本地模式，未连接共享数据", "bad");
    return false;
  }
}

function scheduleRemoteSave() {
  if (!remoteSyncReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(syncStateToRemote, 450);
}

async function syncStateToRemote() {
  if (!remoteSyncReady || saveInFlight) return;
  saveInFlight = true;
  setSyncStatus("正在保存共享数据");
  try {
    const response = await fetch(syncApiUrl, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ state })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    remoteSyncReady = true;
    setSyncStatus("共享数据已保存", "ok");
  } catch (error) {
    remoteSyncReady = false;
    setSyncStatus("保存失败，已保存在本机", "bad");
  } finally {
    saveInFlight = false;
  }
}

function nextId(prefix, list) {
  const nums = list
    .map((item) => Number(String(item.id || "").replace(prefix, "")))
    .filter((n) => Number.isFinite(n));
  return `${prefix}${String((Math.max(0, ...nums) + 1)).padStart(3, "0")}`;
}

function hotelName(id) {
  return state.hotels.find((hotel) => hotel.id === id || hotel.name === id)?.name || id || "未知酒店";
}

function normalizedNeedHotel(hotel) {
  if (hotel === "汉庭酒店") return "汉庭";
  if (hotel === "如家酒店") return "如家";
  if (hotel === "万豪酒店") return "万豪";
  return hotel || "";
}

function needHotels() {
  const names = new Set([...arrangementHotelOptions, ...state.needs.map((need) => normalizedNeedHotel(need.hotel)).filter(Boolean)]);
  return Array.from(names);
}

function needStaysOnDate(date, hotel = "all") {
  return state.needs.filter((need) => (
    need.status !== "已取消" &&
    need.checkIn &&
    need.checkOut &&
    date >= need.checkIn &&
    date < need.checkOut &&
    (hotel === "all" || normalizedNeedHotel(need.hotel) === hotel) &&
    filteredText(need).includes(getSearch())
  ));
}

function needTypeCounts(needs) {
  return needs.reduce((counts, need) => {
    const type = normalizedRoomType(need.roomType);
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
}

function normalizedRoomType(type) {
  if (type === "双床房" || type === "双标间") return "双标";
  if (type === "大床房") return "大床";
  return type || "未填";
}

function typeCountText(needs) {
  const counts = needTypeCounts(needs);
  return Object.entries(counts).map(([type, count]) => `${type}${count}`).join(" / ") || "无需求";
}

function roomTypeCountText(needs) {
  const counts = needTypeCounts(needs);
  return roomTypeOptions.map((type) => `${type}${counts[type] || 0}`).join(" / ");
}

function roomTypeCountClass(type) {
  if (type === "双标") return "room-type-standard";
  if (type === "大床") return "room-type-king";
  if (type === "套房") return "room-type-suite";
  return "room-type-other";
}

function roomTypeCountLines(needs) {
  const counts = needTypeCounts(needs);
  const extraTypes = Object.keys(counts).filter((type) => !roomTypeOptions.includes(type));
  return [...roomTypeOptions, ...extraTypes].map((type) => (
    `<div class="room-type-count-line ${roomTypeCountClass(type)}">${escapeHtml(type)}：${counts[type] || 0}间</div>`
  )).join("");
}

function hotelRoomCountOnDate(date, hotel) {
  return needStaysOnDate(date, hotel).length;
}

function needNightCount(need) {
  return nightsBetween(need.checkIn, need.checkOut).length;
}

function roomLabel(roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return "待定";
  return `${hotelName(room.hotel || room.hotelId)} ${room.roomNo}`;
}

function needById(id) {
  return state.needs.find((item) => item.id === id);
}

function roomById(id) {
  return state.rooms.find((item) => item.id === id);
}

function nightsBetween(checkIn, checkOut) {
  const dates = [];
  let current = checkIn;
  while (current && checkOut && current < checkOut) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function overlaps(aIn, aOut, bIn, bOut) {
  return aIn < bOut && bIn < aOut;
}

function bookingFor(roomId, date) {
  return state.bookings.find((booking) => (
    booking.roomId === roomId &&
    booking.status !== "取消" &&
    date >= booking.checkIn &&
    date < booking.checkOut
  ));
}

function conflicts(roomId, checkIn, checkOut, ignoreId = "") {
  return state.bookings.filter((booking) => (
    booking.roomId === roomId &&
    booking.id !== ignoreId &&
    booking.status !== "取消" &&
    overlaps(checkIn, checkOut, booking.checkIn, booking.checkOut)
  ));
}

function rangesFromDates(dates) {
  const sorted = Array.from(new Set(dates.filter(Boolean))).sort();
  const ranges = [];
  sorted.forEach((date) => {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.end, 0) === date) {
      last.end = addDays(date, 1);
    } else {
      ranges.push({ start: date, end: addDays(date, 1) });
    }
  });
  return ranges;
}

function unmetRangesForNeed(need) {
  if (!need?.checkIn || !need?.checkOut || need.checkIn >= need.checkOut) return [];
  const requiredDates = nightsBetween(need.checkIn, need.checkOut);
  const coveredDates = new Set(
    state.bookings
      .filter((booking) => booking.needId === need.id && booking.status !== "取消")
      .flatMap((booking) => nightsBetween(booking.checkIn, booking.checkOut))
  );
  return rangesFromDates(requiredDates.filter((date) => !coveredDates.has(date)));
}

function roomStatus(roomId, date) {
  const booking = bookingFor(roomId, date);
  if (!booking) return { status: "空闲", className: "pill-free", label: "空闲" };
  if (booking.status === "异常") return { status: "异常", className: "pill-problem", label: "异常" };
  if (booking.checkedIn === "是") return { status: "已入住", className: "pill-checked", label: "已入住" };
  if (booking.confirmed === "是") return { status: "已确认", className: "pill-confirmed", label: "已确认" };
  if (booking.purpose === "备用" || booking.purpose === "自己人") return { status: "预留", className: "pill-reserved", label: booking.purpose };
  return { status: "已分配", className: "pill-assigned", label: "已分配" };
}

function filteredText(item) {
  return Object.values(item).join(" ").toLowerCase();
}

function getSearch() {
  return $("#searchInput").value.trim().toLowerCase();
}

function formatDateForDisplay(value) {
  return value ? value.replaceAll("-", "/") : "";
}

function formatRangeSummary(start, end) {
  return `${formatDateForDisplay(start) || "开始日期"} 至 ${formatDateForDisplay(end) || "结束日期"}`;
}

function dateFromValue(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function dateToValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, offset) {
  const date = dateFromValue(value);
  date.setDate(date.getDate() + offset);
  return dateToValue(date);
}

function monthValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(value) {
  const date = dateFromValue(`${value}-01`);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function addMonths(value, offset) {
  const date = dateFromValue(`${value}-01`);
  date.setMonth(date.getMonth() + offset);
  return monthValue(date);
}

function rangeDraftText(start, end) {
  if (!start && !end) return "请选择开始日期和结束日期";
  if (start && !end) return `已选开始：${formatDateForDisplay(start)}，请选择结束日期`;
  return `已选范围：${formatDateForDisplay(start)} 至 ${formatDateForDisplay(end)}`;
}

function renderRangeCalendar(picker) {
  const grid = picker.querySelector("[data-range-calendar]");
  const title = picker.querySelector("[data-range-month-title]");
  const draft = picker.querySelector("[data-range-draft]");
  const month = picker.dataset.rangeMonth || "2026-08";
  const start = picker.querySelector("[data-range-start]").value;
  const end = picker.querySelector("[data-range-end]").value;
  const monthDate = dateFromValue(`${month}-01`);
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const cursor = new Date(firstDay);
  cursor.setDate(firstDay.getDate() - startOffset);

  title.textContent = monthTitle(month);
  draft.textContent = rangeDraftText(start, end);
  grid.innerHTML = Array.from({ length: 42 }, () => {
    const value = dateToValue(cursor);
    const isCurrentMonth = cursor.getMonth() === monthDate.getMonth();
    const inRange = start && end && value > start && value < end;
    const selected = value === start || value === end;
    const className = [
      "date-day",
      isCurrentMonth ? "" : "muted",
      inRange ? "in-range" : "",
      selected ? "selected" : ""
    ].filter(Boolean).join(" ");
    const html = `<button class="${className}" type="button" data-range-day="${value}">${cursor.getDate()}</button>`;
    cursor.setDate(cursor.getDate() + 1);
    return html;
  }).join("");
}

function refreshDateRangePicker(picker) {
  if (!picker) return;
  const start = picker.querySelector("[data-range-hidden-start]")?.value || "";
  const end = picker.querySelector("[data-range-hidden-end]")?.value || "";
  const summary = picker.querySelector("[data-range-summary]");
  const draft = picker.querySelector("[data-range-draft]");
  if (summary) summary.textContent = formatRangeSummary(start, end);
  if (draft) draft.textContent = rangeDraftText(start, end);
}

function refreshAssignmentDateRange() {
  refreshDateRangePicker(document.querySelector("[data-assignment-range]"));
}

function refreshCalendarDateRange() {
  refreshDateRangePicker(document.querySelector("[data-calendar-range]"));
}

function assignmentPurposeForNeed(need) {
  return need?.identity || "其他";
}

const roomBatchHeaders = ["酒店", "房间号", "楼层", "房型", "可住人数", "可用开始日期", "可用结束日期", "默认用途"];
const roomTypeOptions = ["双标", "大床", "套房"];
const roomUseOptions = ["未分配", "自己人", "工作人员", "导师", "嘉宾", "选手家庭", "合作方", "备用", "其他"];
const needBatchHeaders = ["姓名/团队名称", "身份类型", "联系方式", "人数", "入住日期", "离店日期", "期望房型", "分配状态", "负责人", "备注"];
const identityOptions = ["工作人员", "评委", "嘉宾", "承办单位", "家长"];
const arrangementHotelOptions = ["汉庭", "如家", "万豪"];
const needStatusOptions = ["未分配", "部分分配", "已分配", "已确认", "已取消", "异常"];
const defaultHotelInfoRange = { start: "2026-07-29", end: "2026-08-06" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadRoomTemplate() {
  const rows = [
    roomBatchHeaders,
    ["汉庭酒店", "1001", "1", "双床房", "2", "2026-08-01", "2026-08-06", "未分配"],
    ["如家酒店", "2001", "2", "三人间", "3", "2026-08-01", "2026-08-06", "备用"]
  ];
  const tableHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${tableHtml}</table></body></html>`;
  downloadBlob("酒店房间批量上传模板.xls", html, "application/vnd.ms-excel;charset=utf-8");
}

function downloadNeedTemplate() {
  const rows = [
    needBatchHeaders,
    ["慧慧", "工作人员", "13800000001", "1", "2026-08-01", "2026-08-04", "双床房", "未分配", "现场运营", "晚到保房"],
    ["李春来、王丰领", "工作人员", "13800000002", "2", "2026-08-02", "2026-08-06", "双床房", "未分配", "现场运营", ""]
  ];
  const tableHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${tableHtml}</table></body></html>`;
  downloadBlob("入住需求批量上传模板.xls", html, "application/vnd.ms-excel;charset=utf-8");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((item) => item.some(Boolean));
}

function parseHtmlTable(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  return Array.from(doc.querySelectorAll("tr")).map((tr) => (
    Array.from(tr.querySelectorAll("th,td")).map((cell) => cell.textContent.trim())
  )).filter((row) => row.some(Boolean));
}

function parseRoomBatchRows(text) {
  const rows = /<table[\s>]/i.test(text) ? parseHtmlTable(text) : parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((item) => item.trim());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || "";
    });
    return record;
  }).filter((record) => Object.values(record).some(Boolean));
}

function normalizeDateValue(value) {
  const text = String(value || "").trim().replaceAll("/", "-").replaceAll(".", "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function roomFromBatchRecord(record, index) {
  const hotel = record["酒店"]?.trim();
  const roomNo = record["房间号"]?.trim();
  const availableFrom = normalizeDateValue(record["可用开始日期"]);
  const availableTo = normalizeDateValue(record["可用结束日期"]);
  if (!hotel || !roomNo || !availableFrom || !availableTo) {
    throw new Error(`第 ${index + 2} 行缺少酒店、房间号或可用日期`);
  }
  if (availableFrom >= availableTo) {
    throw new Error(`第 ${index + 2} 行可用结束日期必须晚于开始日期`);
  }
  const type = roomTypeOptions.includes(record["房型"]) ? record["房型"] : "其他";
  const defaultUse = roomUseOptions.includes(record["默认用途"]) ? record["默认用途"] : "未分配";
  return {
    hotel,
    roomNo,
    floor: Number(record["楼层"]) || 1,
    type,
    capacity: Number(record["可住人数"]) || 1,
    availableFrom,
    availableTo,
    defaultUse
  };
}

function needFromBatchRecord(record, index) {
  const name = record["姓名/团队名称"]?.trim();
  const checkIn = normalizeDateValue(record["入住日期"]);
  const checkOut = normalizeDateValue(record["离店日期"]);
  if (!name || !checkIn || !checkOut) {
    throw new Error(`第 ${index + 2} 行缺少姓名/团队名称、入住日期或离店日期`);
  }
  if (checkIn >= checkOut) {
    throw new Error(`第 ${index + 2} 行离店日期必须晚于入住日期`);
  }
  const identity = identityOptions.includes(record["身份类型"]) ? record["身份类型"] : "其他";
  const roomType = roomTypeOptions.includes(record["期望房型"]) ? record["期望房型"] : "其他";
  const status = needStatusOptions.includes(record["分配状态"]) ? record["分配状态"] : "未分配";
  return {
    name,
    identity,
    phone: record["联系方式"] || "",
    people: Number(record["人数"]) || 1,
    checkIn,
    checkOut,
    roomType,
    status,
    owner: record["负责人"] || "",
    note: record["备注"] || "",
    adults: Number(record["人数"]) || 1,
    children: 0,
    sameRoom: "是",
    share: "否",
    quiet: "否",
    smokeFree: "否",
    lowFloor: "否",
    nearElevator: "否",
    confirmed: "否"
  };
}

async function importRoomBatch(file) {
  const text = await file.text();
  const records = parseRoomBatchRows(text);
  if (!records.length) {
    alert("没有识别到可导入的房间数据，请使用下载模板填写后再上传。");
    return;
  }
  const rooms = [];
  try {
    records.forEach((record, index) => rooms.push(roomFromBatchRecord(record, index)));
  } catch (error) {
    alert(error.message);
    return;
  }
  rooms.forEach((room) => {
    state.rooms.push({ id: nextId("R", state.rooms), ...room });
    if (!state.hotels.some((hotel) => hotel.name === room.hotel || hotel.id === room.hotel)) {
      state.hotels.push({ id: room.hotel, name: room.hotel, address: "", contact: "", phone: "" });
    }
    addDatesToEventRange(roomAvailableDates(room));
  });
  saveState();
  render();
  alert(`已批量新增 ${rooms.length} 间房。`);
}

async function importNeedBatch(file) {
  const text = await file.text();
  const records = parseRoomBatchRows(text);
  if (!records.length) {
    alert("没有识别到可导入的入住需求，请使用下载模板填写后再上传。");
    return;
  }
  const needs = [];
  try {
    records.forEach((record, index) => needs.push(needFromBatchRecord(record, index)));
  } catch (error) {
    alert(error.message);
    return;
  }
  needs.forEach((need) => {
    state.needs.push({ id: nextId("REQ-", state.needs), ...need });
    addDatesToEventRange(nightsBetween(need.checkIn, need.checkOut));
  });
  saveState();
  render();
  alert(`已批量新增 ${needs.length} 条入住需求。`);
}

function setView(view) {
  activeView = view;
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  $$(".view").forEach((section) => section.classList.remove("active"));
  const targetView = $(`#${view}View`);
  if (!targetView) return;
  targetView.classList.add("active");
  const titles = {
    dashboard: "总览",
    calendar: "酒店信息",
    needs: "入住需求",
    onsite: "现场核对",
    changes: "变更记录"
  };
  $("#viewTitle").textContent = titles[view];
  render();
}

function kpiData() {
  const nights = state.needs.reduce((sum, need) => sum + needNightCount(need), 0);
  const assignedNights = state.needs.filter((need) => need.hotel).reduce((sum, need) => sum + needNightCount(need), 0);
  const people = state.needs.reduce((sum, need) => sum + (Number(need.people) || 1), 0);
  const unassigned = state.needs.filter((need) => need.status === "未分配").length;
  const assigned = state.needs.filter((need) => need.hotel).length;
  const pendingChanges = state.changes.filter((change) => change.hotelSynced === "否" || change.guestSynced === "否").length;
  return [
    ["总需求房晚", nights, "按入住需求日期计算"],
    ["已安排房晚", assignedNights, "已选择酒店的需求房晚"],
    ["总人数", people, "主人员和增加人员合计"],
    ["已安排需求", assigned, "已指定酒店"],
    ["未分配需求", unassigned, "需要继续处理"],
    ["待处理事项", pendingChanges, "含待同步变更"]
  ];
}

function renderKpis() {
  $("#kpiGrid").innerHTML = kpiData().map(([label, value, hint]) => `
    <article class="kpi">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${hint}</small>
    </article>
  `).join("");
}

function renderHeatmap() {
  const dates = activeDates();
  const hotels = needHotels();
  if (!state.needs.length) {
    $("#heatmap").style.gridTemplateColumns = "1fr";
    $("#heatmap").innerHTML = `<div class="heat-cell header">暂无酒店住宿数据，请先维护入住需求。</div>`;
    return;
  }
  const header = [`<div class="heat-cell header sticky-col">酒店</div>`, ...dates.map((date) => `<div class="heat-cell header">${date.slice(5)}</div>`)];
  const rows = hotels.flatMap((hotel) => {
    return [
      `<div class="heat-cell hotel-name sticky-col">${hotel}<small>入住需求</small></div>`,
      ...dates.map((date) => {
        const needs = needStaysOnDate(date, hotel);
        const className = needs.length >= 5 ? "status-red" : needs.length > 0 ? "status-yellow" : "status-green";
        return `<div class="heat-cell ${className}"><strong>${hotelRoomCountOnDate(date, hotel)} 间</strong><small>${roomTypeCountText(needs)}</small></div>`;
      })
    ];
  });
  $("#heatmap").style.gridTemplateColumns = `150px repeat(${dates.length}, 168px)`;
  $("#heatmap").innerHTML = [...header, ...rows].join("");
}

function renderTasks() {
  const tasks = [];
  state.needs.filter((need) => need.status === "未分配").forEach((need) => {
    tasks.push(["未分配需求", need.name, `${need.identity}｜${need.people}人｜${need.checkIn} 入住`, "status-red"]);
  });
  state.bookings.filter((booking) => booking.confirmed === "否").forEach((booking) => {
    const need = needById(booking.needId);
    tasks.push(["已分配未确认", need?.name || "未知对象", `${roomLabel(booking.roomId)}｜${booking.checkIn} 至 ${booking.checkOut}`, "status-yellow"]);
  });
  state.changes.filter((change) => change.hotelSynced === "否" || change.guestSynced === "否").forEach((change) => {
    tasks.push(["变更待同步", change.target, `${change.type}｜${change.reason}`, "status-red"]);
  });
  $("#taskList").innerHTML = tasks.length ? tasks.slice(0, 8).map(([type, name, desc, cls]) => `
    <div class="task ${cls}">
      <strong>${type}：${name}</strong>
      <span>${desc}</span>
    </div>
  `).join("") : `<div class="task status-green"><strong>暂无紧急事项</strong><span>当前样例数据没有待处理红黄项。</span></div>`;
}

function renderUseBars() {
  const counts = {};
  state.bookings.forEach((booking) => {
    counts[booking.purpose] = (counts[booking.purpose] || 0) + nightsBetween(booking.checkIn, booking.checkOut).length;
  });
  if (!Object.keys(counts).length) {
    $("#useBars").innerHTML = `<div class="task"><strong>暂无安排数据</strong><span>有住宿安排后，这里会显示用途分布。</span></div>`;
    return;
  }
  const max = Math.max(1, ...Object.values(counts));
  $("#useBars").innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([purpose, count]) => `
    <div class="bar-row">
      <span>${purpose}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count / max * 100)}%"></div></div>
      <strong>${count}</strong>
    </div>
  `).join("");
}

function populateFilters() {
  const hotelOptions = [`<option value="all">全部酒店</option>`, ...needHotels().map((hotel) => `<option value="${hotel}">${hotel}</option>`)].join("");
  const dateOptions = activeDates().map((date) => `<option value="${date}">${date}</option>`).join("");
  $("#calendarHotel").innerHTML = hotelOptions;
  $("#onsiteHotel").innerHTML = hotelOptions;
  $("#onsiteDate").innerHTML = dateOptions;
  const dates = activeDates();
  if (!$("#calendarStartInput").value) $("#calendarStartInput").value = defaultHotelInfoRange.start;
  if (!$("#calendarEndInput").value) $("#calendarEndInput").value = defaultHotelInfoRange.end;
  refreshCalendarDateRange();
  if (!$("#onsiteDate").value) $("#onsiteDate").value = activeDates()[0];
}

function renderCalendar() {
  const selectedHotel = $("#calendarHotel").value || "all";
  const checkIn = $("#calendarStartInput").value || activeDates()[0] || defaultDate();
  const checkOut = $("#calendarEndInput").value || checkIn;
  const dates = checkIn <= checkOut ? nightsBetween(checkIn, addDays(checkOut, 1)) : [];
  const hotels = needHotels().filter((hotel) => selectedHotel === "all" || hotel === selectedHotel);
  if (!dates.length) {
    $("#roomBoard").innerHTML = `<div class="board-cell header">请选择开始日期和结束日期。</div>`;
    return;
  }
  if (!hotels.length || !state.needs.length) {
    $("#roomBoard").innerHTML = `<div class="board-cell header">当前筛选条件下暂无入住需求。</div>`;
    return;
  }
  const header = [`<div class="board-cell header">酒店</div>`, ...dates.map((date) => `<div class="board-cell header">${date}</div>`)];
  const rows = hotels.flatMap((hotel) => [
    `<div class="board-cell room-name">${hotel}<small>按入住需求统计</small></div>`,
    ...dates.map((date) => {
      const needs = needStaysOnDate(date, hotel);
      return `
        <div class="board-cell hotel-info-cell">
          <div class="room-type-counts">${roomTypeCountLines(needs)}</div>
        </div>
      `;
    })
  ]);
  $("#roomBoard").innerHTML = `<div class="board-grid" style="grid-template-columns: 136px repeat(${dates.length}, minmax(124px, 1fr))">${[...header, ...rows].join("")}</div>`;
}

function populateAssignmentForm() {
  const pendingNeedRanges = state.needs
    .filter((need) => need.status !== "已取消")
    .flatMap((need) => unmetRangesForNeed(need).map((range, index) => ({ need, range, index })));
  $("#needSelect").innerHTML = pendingNeedRanges.length
    ? pendingNeedRanges.map(({ need, range, index }) => `
      <option value="${need.id}-${index}" data-need-id="${need.id}" data-check-in="${range.start}" data-check-out="${range.end}">
        ${need.name}｜${need.identity}｜${need.people}人｜待满足 ${range.start} 至 ${range.end}
      </option>
    `).join("")
    : `<option value="">暂无待满足日期需求</option>`;
  syncAssignmentDatesFromNeed();
  if (selectedAssignmentNeed()) {
    if (!$("#checkInInput").value) $("#checkInInput").value = activeDates()[0];
    if (!$("#checkOutInput").value) $("#checkOutInput").value = activeDates()[1] || defaultDate(1);
  }
  refreshAssignmentDateRange();
  updateRoomOptions();
}

function selectedAssignmentNeed() {
  const option = $("#needSelect").selectedOptions[0];
  return option ? needById(option.dataset.needId || option.value) : null;
}

function syncAssignmentDatesFromNeed() {
  const option = $("#needSelect").selectedOptions[0];
  const need = selectedAssignmentNeed();
  if (need) {
    $("#checkInInput").value = option?.dataset.checkIn || need.checkIn || "";
    $("#checkOutInput").value = option?.dataset.checkOut || need.checkOut || "";
    $("#purposeInput").value = assignmentPurposeForNeed(need);
    $("#assignNote").value = need.note || "";
    refreshAssignmentDateRange();
  } else {
    $("#checkInInput").value = "";
    $("#checkOutInput").value = "";
    refreshAssignmentDateRange();
  }
}

function updateRoomOptions() {
  const checkIn = $("#checkInInput").value;
  const checkOut = $("#checkOutInput").value;
  if (!selectedAssignmentNeed()) {
    $("#roomSelect").innerHTML = `<option value="">暂无待满足日期需求</option>`;
    updateConflictBox();
    return;
  }
  if (!state.rooms.length) {
    $("#roomSelect").innerHTML = `<option value="">暂无可选房间</option>`;
    updateConflictBox();
    return;
  }
  $("#roomSelect").innerHTML = state.rooms.map((room) => {
    const conflictCount = conflicts(room.id, checkIn, checkOut).length;
    const unavailable = !isRoomAvailableForStay(room, checkIn, checkOut);
    const disabled = conflictCount || unavailable ? "disabled" : "";
    const reason = unavailable ? "｜日期不可用" : (conflictCount ? "｜冲突" : "");
    const label = `${hotelName(room.hotel || room.hotelId)} ${room.roomNo}｜${room.type}｜${room.capacity}人${reason}`;
    return `<option value="${room.id}" ${disabled}>${label}</option>`;
  }).join("");
  updateConflictBox();
}

function updateConflictBox() {
  const roomId = $("#roomSelect").value;
  const checkIn = $("#checkInInput").value;
  const checkOut = $("#checkOutInput").value;
  const box = $("#conflictBox");
  if (!roomId || !checkIn || !checkOut) {
    box.className = "conflict-box";
    box.textContent = "请先维护入住需求和日期。";
    return;
  }
  if (checkIn >= checkOut) {
    box.className = "conflict-box bad";
    box.textContent = "离店日期必须晚于入住日期。";
    return;
  }
  const room = roomById(roomId);
  if (!room || !isRoomAvailableForStay(room, checkIn, checkOut)) {
    box.className = "conflict-box bad";
    box.textContent = `该房间不覆盖所选入住日期。可用范围：${room?.availableFrom || "未设置"} 至 ${room?.availableTo || "未设置"}。`;
    return;
  }
  const list = conflicts(roomId, checkIn, checkOut);
  if (list.length) {
    box.className = "conflict-box bad";
    box.textContent = `发现 ${list.length} 条冲突：${list.map((item) => `${needById(item.needId)?.name || "未知"} ${item.checkIn}-${item.checkOut}`).join("；")}`;
  } else {
    box.className = "conflict-box ok";
    box.textContent = "没有发现同房同晚冲突，可以分配。";
  }
}

function renderAssignments() {
  const rows = state.bookings
    .filter((booking) => filteredText({ ...booking, need: needById(booking.needId)?.name, room: roomLabel(booking.roomId) }).includes(getSearch()))
    .slice()
    .reverse();
  if (!rows.length) {
    $("#assignmentList").innerHTML = `<div class="assignment"><strong>暂无安排记录</strong><span>创建安排后会显示在这里。</span></div>`;
    return;
  }
  $("#assignmentList").innerHTML = rows.map((booking) => {
    const need = needById(booking.needId);
    return `
      <div class="assignment">
        <strong>${need?.name || "未知对象"} → ${roomLabel(booking.roomId)}</strong>
        <span>${booking.checkIn} 至 ${booking.checkOut}｜${booking.people}人｜${booking.status}</span>
        <span>${booking.note || "无备注"}</span>
      </div>
    `;
  }).join("");
}

function table(headers, rows, rowActions) {
  return `
    <thead><tr>${headers.map((h) => `<th>${h.label}</th>`).join("")}<th>操作</th></tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          ${headers.map((h) => `<td>${formatCell(row[h.key], h)}</td>`).join("")}
          <td><div class="row-actions">${rowActions(row)}</div></td>
        </tr>
      `).join("")}
    </tbody>
  `;
}

function formatCell(value, header) {
  if (header.html) return value || "";
  if (header.pill) {
    const cls = value === "未分配" || value === "异常" ? "pill-problem" : value === "已分配" || value === "否" ? "pill-assigned" : "pill-confirmed";
    return `<span class="pill ${cls}">${value || ""}</span>`;
  }
  if (header.multiline) {
    return String(value || "").split("\n").filter(Boolean).map((line) => `<div class="compact-lines">${line}</div>`).join("");
  }
  return value ?? "";
}

function refreshNeedAssignmentStatus(need) {
  if (!need || need.status === "已取消") return;
  const activeBookings = state.bookings.filter((booking) => booking.needId === need.id && booking.status !== "取消");
  if (!activeBookings.length) {
    need.status = "未分配";
    return;
  }
  need.status = unmetRangesForNeed(need).length ? "部分分配" : "已分配";
}

function assignmentSummaryForNeed(needId) {
  const bookings = state.bookings.filter((booking) => booking.needId === needId && booking.status !== "取消");
  return {
    assignedRoomTime: bookings.map((booking) => `
      <div class="assigned-booking-line">
        <span>${roomLabel(booking.roomId)}｜${booking.checkIn} 至 ${booking.checkOut}</span>
        <button class="mini-btn danger-mini-btn" type="button" data-delete-booking="${booking.id}">删除</button>
      </div>
    `).join("")
  };
}

function companionSummary(companions) {
  if (!Array.isArray(companions) || !companions.length) return "";
  return companions.map((person) => person.name || person.phone || "未命名").join("、");
}

function peopleForNeed(need) {
  const companions = Array.isArray(need.companions) ? need.companions : [];
  return [need, ...companions];
}

function peopleFieldCell(need, key) {
  return `
    <div class="people-stack-cell">
      ${peopleForNeed(need).map((person) => `<div class="people-stack-line">${escapeHtml(person[key] || "-")}</div>`).join("")}
    </div>
  `;
}

function stayTimeCell(need) {
  return `
    <div class="stay-time-cell">
      <div><span>入住</span><strong>${escapeHtml(need.checkIn || "")}</strong></div>
      <div><span>离店</span><strong>${escapeHtml(need.checkOut || "")}</strong></div>
    </div>
  `;
}

function renderNeeds() {
  const rows = state.needs
    .filter((need) => filteredText(need).includes(getSearch()))
    .map((need, index) => ({
      ...need,
      sequence: index + 1,
      nameList: peopleFieldCell(need, "name"),
      genderList: peopleFieldCell(need, "gender"),
      phoneList: peopleFieldCell(need, "phone"),
      idNoList: peopleFieldCell(need, "idNo"),
      identityList: peopleFieldCell(need, "identity"),
      stayTime: stayTimeCell(need)
    }));
  $("#needsSummary").textContent = `共 ${rows.length} 条需求，未分配 ${rows.filter((item) => item.status === "未分配").length} 条`;
  $("#needsTable").innerHTML = table([
    { key: "sequence", label: "序号" },
    { key: "nameList", label: "姓名", html: true },
    { key: "genderList", label: "性别", html: true },
    { key: "phoneList", label: "电话", html: true },
    { key: "idNoList", label: "身份证号", html: true },
    { key: "identityList", label: "人员性质", html: true },
    { key: "stayTime", label: "入住时间", html: true },
    { key: "hotel", label: "安排酒店" },
    { key: "roomType", label: "房间类型" },
    { key: "status", label: "状态", pill: true },
    { key: "note", label: "备注" }
  ], rows, (row) => `
    <button class="mini-btn" data-edit-need="${row.id}">编辑</button>
    <button class="mini-btn danger-mini-btn" data-delete-need="${row.id}">删除</button>
  `);
}

function renderRooms() {
  const rooms = state.rooms.filter((room) => filteredText({ ...room, hotel: hotelName(room.hotel || room.hotelId) }).includes(getSearch()));
  $("#roomsSummary").textContent = `共 ${rooms.length} 间房，覆盖 ${state.hotels.length} 家酒店`;
  $("#roomCards").innerHTML = rooms.map((room) => `
    <article class="room-card">
      <h3>${hotelName(room.hotel || room.hotelId)} ${room.roomNo}</h3>
      <p>${room.type}</p>
      <div class="room-meta">
        <span>楼层：${room.floor}</span>
        <span>可住：${room.capacity}人</span>
        <span>可用：${room.availableFrom || "未设"} 至 ${room.availableTo || "未设"}</span>
      </div>
      <button class="mini-btn" data-edit-room="${room.id}">编辑</button>
    </article>
  `).join("");
}

function renderOnsite() {
  const date = $("#onsiteDate").value || activeDates()[0];
  const hotel = $("#onsiteHotel").value || "all";
  const rows = state.bookings
    .filter((booking) => date >= booking.checkIn && date < booking.checkOut)
    .filter((booking) => hotel === "all" || (roomById(booking.roomId)?.hotel || roomById(booking.roomId)?.hotelId) === hotel)
    .filter((booking) => filteredText({ ...booking, need: needById(booking.needId)?.name, room: roomLabel(booking.roomId) }).includes(getSearch()))
    .map((booking) => ({
      id: booking.id,
      date,
      room: roomLabel(booking.roomId),
      roomType: roomById(booking.roomId)?.type || "",
      name: needById(booking.needId)?.name || "",
      identity: needById(booking.needId)?.identity || "",
      people: booking.people,
      phone: needById(booking.needId)?.phone || "",
      confirmed: booking.confirmed,
      checkedIn: booking.checkedIn,
      note: booking.note
    }));
  $("#onsiteTable").innerHTML = table([
    { key: "date", label: "日期" },
    { key: "room", label: "房间" },
    { key: "roomType", label: "房型" },
    { key: "name", label: "入住人/团队" },
    { key: "identity", label: "身份" },
    { key: "people", label: "人数" },
    { key: "phone", label: "联系方式" },
    { key: "confirmed", label: "确认", pill: true },
    { key: "checkedIn", label: "到店", pill: true },
    { key: "note", label: "备注" }
  ], rows, (row) => `<button class="mini-btn" data-toggle-checkin="${row.id}">${row.checkedIn === "是" ? "撤销到店" : "确认到店"}</button>`);
}

function renderChanges() {
  const rows = state.changes.filter((change) => filteredText(change).includes(getSearch()));
  $("#changesTable").innerHTML = table([
    { key: "id", label: "变更ID" },
    { key: "time", label: "时间" },
    { key: "type", label: "类型", pill: true },
    { key: "target", label: "对象" },
    { key: "oldRoom", label: "原房间" },
    { key: "newRoom", label: "新房间" },
    { key: "reason", label: "原因" },
    { key: "operator", label: "操作人" },
    { key: "hotelSynced", label: "同步酒店", pill: true },
    { key: "guestSynced", label: "同步入住人", pill: true }
  ], rows, (row) => `<button class="mini-btn" data-edit-change="${row.id}">编辑</button>`);
}

function render() {
  populateFilters();
  if (activeView === "dashboard") {
    renderKpis();
    renderHeatmap();
    renderTasks();
    renderUseBars();
  }
  if (activeView === "calendar") renderCalendar();
  if (activeView === "needs") renderNeeds();
  if (activeView === "onsite") renderOnsite();
  if (activeView === "changes") renderChanges();
}

function openDialog(title, fields, initial, onSave) {
  editing = { fields, initial, onSave };
  $("#dialogForm").classList.toggle("room-dialog-card", fields.some((field) => field.largeDialog));
  $("#dialogTitle").textContent = title;
  $("#dialogFields").innerHTML = fields.map((field) => {
    if (field.type === "hidden") {
      const value = initial[field.key] ?? field.default ?? "";
      return `<input name="${field.key}" type="hidden" value="${value}">`;
    }
    const full = field.type === "textarea" || field.type === "dateRange" ? " full" : "";
    const value = initial[field.key] ?? field.default ?? "";
    if (field.type === "dateRange") {
      const startValue = initial[field.startKey] ?? "";
      const endValue = initial[field.endKey] ?? "";
      return `
        <div class="${full} dialog-field">
          <span class="dialog-field-label">${field.label}</span>
          <div class="date-range-picker" data-date-range>
            <input type="hidden" name="${field.startKey}" value="${startValue}" data-range-hidden-start>
            <input type="hidden" name="${field.endKey}" value="${endValue}" data-range-hidden-end>
            <button class="date-range-trigger" type="button" data-range-trigger>
              <span data-range-summary>${formatRangeSummary(startValue, endValue)}</span>
              <span class="date-range-calendar-icon" aria-hidden="true"></span>
            </button>
            <div class="date-range-panel" data-range-panel hidden>
              <input type="hidden" value="${startValue}" data-range-start>
              <input type="hidden" value="${endValue}" data-range-end>
              <div class="date-range-body">
                <section class="date-calendar">
                  <div class="date-calendar-head">
                    <button type="button" data-range-month-nav="-12">«</button>
                    <button type="button" data-range-month-nav="-1">‹</button>
                    <strong data-range-month-title></strong>
                    <button type="button" data-range-month-nav="1">›</button>
                    <button type="button" data-range-month-nav="12">»</button>
                  </div>
                  <div class="date-week-row">
                    <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
                  </div>
                  <div class="date-grid" data-range-calendar></div>
                </section>
              </div>
              <div class="date-range-footer">
                <span data-range-draft>请选择开始日期和结束日期</span>
                <button class="primary-btn" type="button" data-range-apply>确认</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    if (field.type === "peopleRepeater") {
      const companions = Array.isArray(initial[field.key]) ? initial[field.key] : [];
      return `
        <div class="full companion-editor" data-companion-editor>
          <button class="ghost-btn add-person-btn" type="button" data-add-companion>增加人员</button>
          <div class="companion-list" data-companion-list>
            ${companions.map((person) => companionCard(person)).join("")}
          </div>
        </div>
      `;
    }
    if (field.type === "select") {
      return `<label class="${full}">${field.label}<select name="${field.key}">${field.options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${option || "未安排"}</option>`).join("")}</select></label>`;
    }
    if (field.type === "textarea") {
      return `<label class="${full}">${field.label}<textarea name="${field.key}" rows="3">${value}</textarea></label>`;
    }
    return `<label class="${full}">${field.label}<input name="${field.key}" type="${field.type || "text"}" value="${value}"></label>`;
  }).join("");
  $("#editDialog").showModal();
}

function companionCard(person = {}) {
  const gender = person.gender || "男";
  const identity = person.identity || "工作人员";
  return `
    <div class="companion-card" data-companion-card>
      <div class="companion-card-head">
        <strong>人员信息</strong>
        <button class="mini-btn" type="button" data-remove-companion>删除</button>
      </div>
      <label>姓名<input data-companion-key="name" value="${escapeHtml(person.name || "")}"></label>
      <label>性别
        <select data-companion-key="gender">
          ${["男", "女"].map((option) => `<option value="${option}" ${option === gender ? "selected" : ""}>${option}</option>`).join("")}
        </select>
      </label>
      <label>电话<input data-companion-key="phone" value="${escapeHtml(person.phone || "")}"></label>
      <label>身份证号<input data-companion-key="idNo" value="${escapeHtml(person.idNo || "")}"></label>
      <label>人员性质
        <select data-companion-key="identity">
          ${identityOptions.map((option) => `<option value="${option}" ${option === identity ? "selected" : ""}>${option}</option>`).join("")}
        </select>
      </label>
    </div>
  `;
}

function dialogValues() {
  const data = {};
  new FormData($("#dialogForm")).forEach((value, key) => {
    data[key] = value;
  });
  const companionEditor = $("#dialogForm [data-companion-editor]");
  if (companionEditor) {
    data.companions = Array.from(companionEditor.querySelectorAll("[data-companion-card]")).map((card) => {
      const person = {};
      card.querySelectorAll("[data-companion-key]").forEach((input) => {
        person[input.dataset.companionKey] = input.value.trim();
      });
      return person;
    }).filter((person) => person.name || person.phone || person.idNo);
  }
  return data;
}

function normalizeNeedValues(values) {
  const companions = Array.isArray(values.companions) ? values.companions : [];
  const people = 1 + companions.length;
  return {
    ...values,
    companions,
    people,
    adults: people,
    status: values.hotel ? "已分配" : "未分配"
  };
}

function needFields() {
  return [
    { key: "name", label: "姓名" },
    { key: "gender", label: "性别", type: "select", options: ["男", "女"] },
    { key: "phone", label: "电话" },
    { key: "idNo", label: "身份证号" },
    { key: "identity", label: "人员性质", type: "select", options: identityOptions },
    { key: "people", type: "hidden", default: 1 },
    { key: "status", type: "hidden", default: "未分配" },
    { key: "companions", type: "peopleRepeater" },
    { key: "hotel", label: "安排酒店", type: "select", options: ["", ...arrangementHotelOptions] },
    { key: "roomType", label: "房间类型", type: "select", options: roomTypeOptions },
    { label: "日期", type: "dateRange", startKey: "checkIn", endKey: "checkOut" },
    { key: "note", label: "备注", type: "textarea" }
  ];
}

function roomFields() {
  return [
    { key: "hotel", label: "酒店", type: "select", options: state.hotels.length ? state.hotels.map((hotel) => hotel.name) : [""] },
    { key: "roomNo", label: "房间号" },
    { key: "floor", label: "楼层", type: "number" },
    { key: "type", label: "房型", type: "select", options: ["大床房", "双床房", "三人间", "家庭房", "套房", "其他"] },
    { key: "capacity", label: "可住人数", type: "number" },
    { label: "可用时间范围", type: "dateRange", startKey: "availableFrom", endKey: "availableTo", largeDialog: true },
    { key: "defaultUse", label: "默认用途", type: "select", options: ["未分配", "自己人", "工作人员", "导师", "嘉宾", "选手家庭", "合作方", "备用", "其他"] }
  ];
}

function changeFields() {
  return [
    { key: "time", label: "变更时间" },
    { key: "type", label: "变更类型", type: "select", options: ["新增", "取消", "换房", "延期", "提前退房", "人数变化", "房型变化", "备注修改", "其他"] },
    { key: "target", label: "关联入住对象" },
    { key: "oldRoom", label: "原酒店/房间" },
    { key: "newRoom", label: "新酒店/房间" },
    { key: "operator", label: "操作人" },
    { key: "hotelSynced", label: "已同步酒店", type: "select", options: ["是", "否"] },
    { key: "guestSynced", label: "已同步入住人", type: "select", options: ["是", "否"] },
    { key: "reason", label: "变更原因", type: "textarea" }
  ];
}

function bindEvents() {
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("#searchInput").addEventListener("input", render);
  $("#calendarHotel").addEventListener("change", renderCalendar);
  $("#onsiteDate").addEventListener("change", renderOnsite);
  $("#onsiteHotel").addEventListener("change", renderOnsite);

  $("#needSelect")?.addEventListener("change", () => {
    syncAssignmentDatesFromNeed();
    updateRoomOptions();
  });
  ["checkInInput", "checkOutInput"].forEach((id) => {
    $(`#${id}`)?.addEventListener("change", updateRoomOptions);
  });
  $("#roomSelect")?.addEventListener("change", updateConflictBox);

  $("#assignForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomId = $("#roomSelect").value;
    const need = selectedAssignmentNeed();
    const checkIn = $("#checkInInput").value;
    const checkOut = $("#checkOutInput").value;
    if (!need || conflicts(roomId, checkIn, checkOut).length || checkIn >= checkOut) {
      updateConflictBox();
      return;
    }
    const booking = {
      id: nextId("B", state.bookings),
      needId: need.id,
      roomId,
      checkIn,
      checkOut,
      people: Number(need.people),
      purpose: $("#purposeInput").value,
      status: "已分配",
      confirmed: "否",
      checkedIn: "否",
      checkedOut: "否",
      operator: need.owner || "现场运营",
      note: $("#assignNote").value.trim()
    };
    state.bookings.push(booking);
    refreshNeedAssignmentStatus(need);
    saveState();
    $("#assignNote").value = "";
    render();
  });

  $("#addNeedBtn").addEventListener("click", () => {
    openDialog("新增入住需求", needFields(), {
      id: nextId("REQ-", state.needs),
      people: 1,
      gender: "男",
      checkIn: activeDates()[0],
      checkOut: activeDates()[1] || defaultDate(1),
      identity: "工作人员",
      roomType: "双标",
      status: "未分配"
    }, (values) => {
      state.needs.push({ id: nextId("REQ-", state.needs), children: 0, sameRoom: "是", share: "否", quiet: "否", smokeFree: "否", lowFloor: "否", nearElevator: "否", confirmed: "否", ...normalizeNeedValues(values) });
      addDatesToEventRange(nightsBetween(values.checkIn, values.checkOut));
    });
  });
  $("#downloadNeedTemplateBtn").addEventListener("click", downloadNeedTemplate);
  $("#needBatchInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await importNeedBatch(file);
    event.target.value = "";
  });

  $("#addRoomBtn")?.addEventListener("click", () => {
    openDialog("新增房间", roomFields(), {
      hotel: state.hotels[0]?.name || "",
      floor: 1,
      type: "双床房",
      capacity: 2,
      availableFrom: "2026-08-01",
      availableTo: "2026-08-06",
      defaultUse: "未分配"
    }, (values) => {
      state.rooms.push({ id: nextId("R", state.rooms), ...values, floor: Number(values.floor) || 1, capacity: Number(values.capacity) || 1 });
      addDatesToEventRange(roomAvailableDates(values));
    });
  });
  $("#downloadRoomTemplateBtn")?.addEventListener("click", downloadRoomTemplate);
  $("#roomBatchInput")?.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await importRoomBatch(file);
    event.target.value = "";
  });

  $("#addChangeBtn").addEventListener("click", () => {
    openDialog("记录变更", changeFields(), {
      time: new Date().toISOString().slice(0, 16).replace("T", " "),
      type: "其他",
      hotelSynced: "否",
      guestSynced: "否"
    }, (values) => {
      state.changes.push({ id: nextId("CHG-", state.changes), ...values });
    });
  });

  document.body.addEventListener("click", (event) => {
    const rangeTrigger = event.target.closest("[data-range-trigger]");
    const rangeApply = event.target.closest("[data-range-apply]");
    const rangeMonthNav = event.target.closest("[data-range-month-nav]");
    const rangeDay = event.target.closest("[data-range-day]");
    const addCompanionBtn = event.target.closest("[data-add-companion]");
    const removeCompanionBtn = event.target.closest("[data-remove-companion]");
    if (rangeTrigger) {
      event.preventDefault();
      const picker = rangeTrigger.closest("[data-date-range]");
      const panel = picker.querySelector("[data-range-panel]");
      const hiddenStart = picker.querySelector("[data-range-hidden-start]").value;
      const hiddenEnd = picker.querySelector("[data-range-hidden-end]").value;
      picker.querySelector("[data-range-start]").value = hiddenStart;
      picker.querySelector("[data-range-end]").value = hiddenEnd;
      picker.dataset.rangeMonth = (hiddenStart || hiddenEnd || "2026-08-01").slice(0, 7);
      renderRangeCalendar(picker);
      panel.hidden = !panel.hidden;
      return;
    }
    if (rangeMonthNav) {
      event.preventDefault();
      const picker = rangeMonthNav.closest("[data-date-range]");
      picker.dataset.rangeMonth = addMonths(picker.dataset.rangeMonth || "2026-08", Number(rangeMonthNav.dataset.rangeMonthNav));
      renderRangeCalendar(picker);
      return;
    }
    if (rangeDay) {
      event.preventDefault();
      const picker = rangeDay.closest("[data-date-range]");
      const startInput = picker.querySelector("[data-range-start]");
      const endInput = picker.querySelector("[data-range-end]");
      const value = rangeDay.dataset.rangeDay;
      if (!startInput.value || endInput.value) {
        startInput.value = value;
        endInput.value = "";
      } else if (value < startInput.value) {
        endInput.value = startInput.value;
        startInput.value = value;
      } else {
        endInput.value = value;
      }
      picker.dataset.rangeMonth = value.slice(0, 7);
      renderRangeCalendar(picker);
      return;
    }
    if (rangeApply) {
      event.preventDefault();
      const picker = rangeApply.closest("[data-date-range]");
      const start = picker.querySelector("[data-range-start]").value;
      const end = picker.querySelector("[data-range-end]").value;
      picker.querySelector("[data-range-hidden-start]").value = start;
      picker.querySelector("[data-range-hidden-end]").value = end;
      picker.querySelector("[data-range-summary]").textContent = formatRangeSummary(start, end);
      picker.querySelector("[data-range-panel]").hidden = true;
      if (picker.matches("[data-assignment-range]")) updateRoomOptions();
      if (picker.matches("[data-calendar-range]")) renderCalendar();
      return;
    }
    if (addCompanionBtn) {
      event.preventDefault();
      addCompanionBtn.closest("[data-companion-editor]").querySelector("[data-companion-list]").insertAdjacentHTML("beforeend", companionCard());
      return;
    }
    if (removeCompanionBtn) {
      event.preventDefault();
      removeCompanionBtn.closest("[data-companion-card]").remove();
      return;
    }
    const needBtn = event.target.closest("[data-edit-need]");
    const roomBtn = event.target.closest("[data-edit-room]");
    const changeBtn = event.target.closest("[data-edit-change]");
    const checkBtn = event.target.closest("[data-toggle-checkin]");
    const deleteBookingBtn = event.target.closest("[data-delete-booking]");
    const deleteNeedBtn = event.target.closest("[data-delete-need]");
    if (deleteNeedBtn) {
      const need = needById(deleteNeedBtn.dataset.deleteNeed);
      if (!need) return;
      if (!confirm(`确定删除 ${need.name || "这条入住需求"} 吗？关联的安排记录也会一起删除。`)) return;
      state.needs = state.needs.filter((item) => item.id !== need.id);
      state.bookings = state.bookings.filter((booking) => booking.needId !== need.id);
      saveState();
      render();
      return;
    }
    if (deleteBookingBtn) {
      const booking = state.bookings.find((item) => item.id === deleteBookingBtn.dataset.deleteBooking);
      if (!booking) return;
      const need = needById(booking.needId);
      if (!confirm(`确定删除 ${need?.name || "该对象"} 的这条安排记录吗？删除后会重新进入待安排状态。`)) return;
      state.bookings = state.bookings.filter((item) => item.id !== booking.id);
      refreshNeedAssignmentStatus(need);
      saveState();
      render();
      return;
    }
    if (needBtn) {
      const need = needById(needBtn.dataset.editNeed);
      openDialog("编辑入住需求", needFields(), need, (values) => Object.assign(need, normalizeNeedValues(values)));
    }
    if (roomBtn) {
      const room = roomById(roomBtn.dataset.editRoom);
      openDialog("编辑房间", roomFields(), room, (values) => {
        Object.assign(room, values, { floor: Number(values.floor) || 1, capacity: Number(values.capacity) || 1 });
        addDatesToEventRange(roomAvailableDates(room));
      });
    }
    if (changeBtn) {
      const change = state.changes.find((item) => item.id === changeBtn.dataset.editChange);
      openDialog("编辑变更记录", changeFields(), change, (values) => Object.assign(change, values));
    }
    if (checkBtn) {
      const booking = state.bookings.find((item) => item.id === checkBtn.dataset.toggleCheckin);
      booking.checkedIn = booking.checkedIn === "是" ? "否" : "是";
      booking.status = booking.checkedIn === "是" ? "已入住" : booking.status;
      saveState();
      render();
    }
  });

  $("#dialogForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editing) return;
    editing.onSave(dialogValues());
    saveState();
    $("#editDialog").close();
    editing = null;
    render();
  });
  $("#dialogCancel").addEventListener("click", () => $("#editDialog").close());

  $("#exportBtn")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "活动酒店房间分配系统数据.json";
    link.click();
    URL.revokeObjectURL(url);
  });

  $("#importInput")?.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    state = JSON.parse(text);
    saveState();
    render();
  });

  $("#resetBtn")?.addEventListener("click", () => {
    if (!confirm("确定恢复样例数据吗？当前本地修改会被覆盖。")) return;
    state = structuredClone(sampleData);
    saveState();
    render();
  });
}

async function initializeApp() {
  bindEvents();
  render();
  const loaded = await loadRemoteState();
  if (loaded) render();
}

initializeApp();
