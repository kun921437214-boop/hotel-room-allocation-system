const ExcelJS = require("exceljs");

const DEFAULT_IDENTITIES = ["工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"];
const DEFAULT_ROOM_TYPES = ["双标", "大床", "套房"];
const MAX_NEEDS = 2000;
const MAX_COMPANIONS = 20;

const COLORS = {
  border: "FF3B3B3B",
  header: "FFF2F4F7",
  title: "FFEAF0F8",
  available: "FFFFE8E8",
  used: "FFE6F6EF",
  remaining: "FFE8F0FF",
  standard: "FFFFF2D6",
  king: "FFE8F0FF",
  suite: "FFE6F6EF",
  other: "FFEEE9FF",
  total: "FFEEF1F5"
};

const BORDER = {
  top: { style: "thin", color: { argb: COLORS.border } },
  left: { style: "thin", color: { argb: COLORS.border } },
  bottom: { style: "thin", color: { argb: COLORS.border } },
  right: { style: "thin", color: { argb: COLORS.border } }
};

function text(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizedHotel(value) {
  const hotel = text(value, 80);
  if (hotel === "汉庭" || hotel === "汉庭酒店") return "诺富特";
  if (hotel === "如家" || hotel === "如家酒店") return "宜必思";
  if (hotel === "万豪" || hotel === "万豪酒店") return "施柏阁";
  if (hotel === "诺富特酒店") return "诺富特";
  if (hotel === "宜必思酒店") return "宜必思";
  if (hotel === "施柏阁酒店") return "施柏阁";
  if (hotel === "大观酒店") return "大观";
  return hotel;
}

function normalizedRoomType(value) {
  const roomType = text(value, 40);
  if (roomType === "双床房" || roomType === "双标间") return "双标";
  if (roomType === "大床房") return "大床";
  if (roomType === "套房") return "套房";
  if (roomType === "双标" || roomType === "大床") return roomType;
  return "其他";
}

function normalizedIdentity(value) {
  const identity = text(value, 40);
  return DEFAULT_IDENTITIES.includes(identity) ? identity : "其他";
}

function displayRoomType(value) {
  const roomType = normalizedRoomType(value);
  if (roomType === "双标") return "双标间";
  if (roomType === "大床") return "大床房";
  if (roomType === "套房") return "套房";
  return "其他";
}

function parseDateValue(value) {
  const match = text(value, 20).match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function dateValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, offset) {
  const date = parseDateValue(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + offset);
  return dateValue(date);
}

function nightsBetween(checkIn, checkOut) {
  if (!parseDateValue(checkIn) || !parseDateValue(checkOut) || checkIn >= checkOut) return [];
  const dates = [];
  let cursor = checkIn;
  while (cursor < checkOut && dates.length < 366) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function sanitizePerson(person, fallbackIdentity) {
  return {
    name: text(person?.name, 120),
    gender: text(person?.gender, 20),
    phone: text(person?.phone, 80),
    idNo: text(person?.idNo, 100),
    identity: normalizedIdentity(person?.identity || fallbackIdentity)
  };
}

function sanitizeNeed(need, index) {
  const identity = normalizedIdentity(need?.identity);
  const companions = Array.isArray(need?.companions) ? need.companions.slice(0, MAX_COMPANIONS) : [];
  return {
    id: text(need?.id, 100) || `NEED-${index + 1}`,
    name: text(need?.name, 120),
    gender: text(need?.gender, 20),
    phone: text(need?.phone, 80),
    idNo: text(need?.idNo, 100),
    identity,
    companions: companions.map((person) => sanitizePerson(person, identity)),
    hotel: normalizedHotel(need?.hotel),
    roomNo: text(need?.roomNo, 80),
    roomType: normalizedRoomType(need?.roomType),
    checkIn: dateValue(parseDateValue(need?.checkIn)),
    checkOut: dateValue(parseDateValue(need?.checkOut)),
    cabin: text(need?.cabin, 80),
    outboundFlight: text(need?.outboundFlight, 300),
    returnFlight: text(need?.returnFlight, 300),
    note: text(need?.note, 500)
  };
}

function sanitizeNeeds(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_NEEDS) throw new Error(`单次最多导出 ${MAX_NEEDS} 条住宿需求`);
  return input.map(sanitizeNeed);
}

function peopleForNeed(need) {
  return [sanitizePerson(need, need.identity), ...need.companions];
}

function roomTypesForNeeds(needs) {
  const usedTypes = new Set(needs.map((need) => normalizedRoomType(need.roomType)));
  return [...DEFAULT_ROOM_TYPES, ...(usedTypes.has("其他") ? ["其他"] : [])];
}

function datesForNeeds(needs, suppliedDates = []) {
  const dates = new Set();
  needs.forEach((need) => nightsBetween(need.checkIn, need.checkOut).forEach((date) => dates.add(date)));
  if (!dates.size && Array.isArray(suppliedDates)) {
    suppliedDates.forEach((value) => {
      const date = dateValue(parseDateValue(value));
      if (date) dates.add(date);
    });
  }
  return Array.from(dates).sort();
}

function needContainsIdentity(need, identity) {
  return peopleForNeed(need).some((person) => person.identity === identity);
}

function needBelongsToIdentity(need, identity) {
  return need.identity === identity;
}

function needStaysOnDate(need, date) {
  return Boolean(need.checkIn && need.checkOut && date >= need.checkIn && date < need.checkOut);
}

function needsForDateAndType(needs, date, roomType) {
  return needs.filter((need) => needStaysOnDate(need, date) && normalizedRoomType(need.roomType) === roomType);
}

function roomTypeFill(type) {
  if (type === "双标") return COLORS.standard;
  if (type === "大床") return COLORS.king;
  if (type === "套房") return COLORS.suite;
  return COLORS.other;
}

function totalCapacity(capacities, date, roomType) {
  if (!capacities || typeof capacities !== "object") return 0;
  return Object.values(capacities).reduce((sum, byDate) => {
    const value = Number(byDate?.[date]?.[roomType] || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function applyCellStyle(cell, options = {}) {
  cell.font = {
    name: "宋体",
    size: options.fontSize || 11,
    bold: Boolean(options.bold),
    color: { argb: options.fontColor || "FF000000" }
  };
  cell.alignment = {
    horizontal: options.horizontal || "center",
    vertical: "middle",
    wrapText: Boolean(options.wrapText)
  };
  cell.border = BORDER;
  if (options.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: options.fill } };
  if (options.numFmt) cell.numFmt = options.numFmt;
}

function styleRange(sheet, startRow, endRow, startCol, endCol, options = {}) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      applyCellStyle(sheet.getCell(row, col), options);
    }
  }
}

function setDateCell(cell, value) {
  const date = parseDateValue(value);
  cell.value = date || null;
  if (date) cell.numFmt = "yyyy/m/d";
}

function setTextCell(cell, value) {
  cell.value = text(value) || null;
  cell.numFmt = "@";
}

function addTotalSheet(workbook, needs, sequenceByNeed) {
  const sheet = workbook.addWorksheet("总表", { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = [
    "性质", "序号", "入住人姓名", "房间类型", "入住日期", "退房日期", "入住天数", "电话",
    "身份证号码", "性别", "安排酒店", "房间号", "舱位", "去程航班", "返程航班", "备注"
  ];
  const widths = [12, 8, 16, 12, 12, 12, 10, 16, 23, 8, 14, 12, 12, 24, 24, 30];
  sheet.columns = widths.map((width) => ({ width }));
  sheet.getRow(1).values = headers;
  sheet.getRow(1).height = 28;
  styleRange(sheet, 1, 1, 1, headers.length, { fill: COLORS.header, bold: true, fontSize: 12, wrapText: true });

  let rowIndex = 2;
  needs.forEach((need) => {
    const sequence = sequenceByNeed.get(need.id);
    peopleForNeed(need).forEach((person, personIndex) => {
      const row = sheet.getRow(rowIndex);
      row.height = 24;
      row.getCell(1).value = person.identity;
      row.getCell(2).value = sequence;
      row.getCell(3).value = person.name || null;
      row.getCell(4).value = displayRoomType(need.roomType);
      setDateCell(row.getCell(5), need.checkIn);
      setDateCell(row.getCell(6), need.checkOut);
      if (personIndex === 0 && need.checkIn && need.checkOut) {
        row.getCell(7).value = nightsBetween(need.checkIn, need.checkOut).length;
        row.getCell(7).numFmt = "0";
      }
      setTextCell(row.getCell(8), person.phone);
      setTextCell(row.getCell(9), person.idNo);
      row.getCell(10).value = person.gender || null;
      row.getCell(11).value = need.hotel || null;
      setTextCell(row.getCell(12), need.roomNo);
      row.getCell(13).value = need.cabin || null;
      row.getCell(14).value = need.outboundFlight || null;
      row.getCell(15).value = need.returnFlight || null;
      row.getCell(16).value = need.note || null;
      styleRange(sheet, rowIndex, rowIndex, 1, headers.length, { wrapText: true });
      rowIndex += 1;
    });
  });

  if (rowIndex > 2) sheet.autoFilter = { from: "A1", to: `P${rowIndex - 1}` };
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return sheet;
}

function mergeHeader(sheet, row, startCol, span, value, fill = COLORS.title) {
  if (span > 1) sheet.mergeCells(row, startCol, row, startCol + span - 1);
  const cell = sheet.getCell(row, startCol);
  cell.value = value;
  styleRange(sheet, row, row, startCol, startCol + span - 1, { fill, bold: true, fontSize: 11 });
}

function addSummarySheet(workbook, needs, dates, roomTypes, identities, capacities) {
  const sheet = workbook.addWorksheet("汇总", { views: [{ state: "frozen", xSplit: 1, ySplit: 6 }] });
  const firstDataCol = 2;
  const totalCol = firstDataCol + dates.length * roomTypes.length;
  sheet.getColumn(1).width = 22;
  for (let col = firstDataCol; col < totalCol; col += 1) sheet.getColumn(col).width = 9;
  sheet.getColumn(totalCol).width = 11;

  ["可用", "实际", "剩余"].forEach((label, index) => {
    const row = index + 2;
    sheet.getCell(row, 1).value = label;
    const fill = index === 0 ? COLORS.available : index === 1 ? COLORS.used : COLORS.remaining;
    styleRange(sheet, row, row, 1, totalCol, { fill, bold: true });
  });

  dates.forEach((date, dateIndex) => {
    const startCol = firstDataCol + dateIndex * roomTypes.length;
    mergeHeader(sheet, 5, startCol, roomTypes.length, date, COLORS.title);
    roomTypes.forEach((roomType, typeIndex) => {
      const col = startCol + typeIndex;
      const available = totalCapacity(capacities, date, roomType);
      const used = needsForDateAndType(needs, date, roomType).length;
      sheet.getCell(2, col).value = available;
      sheet.getCell(3, col).value = used;
      sheet.getCell(4, col).value = available - used;
      sheet.getCell(6, col).value = roomType;
      applyCellStyle(sheet.getCell(6, col), { fill: roomTypeFill(roomType), bold: true });
    });
  });

  sheet.getCell(6, 1).value = "入住人类型";
  applyCellStyle(sheet.getCell(6, 1), { fill: COLORS.header, bold: true });
  sheet.mergeCells(5, totalCol, 6, totalCol);
  sheet.getCell(5, totalCol).value = "总计";
  styleRange(sheet, 5, 6, totalCol, totalCol, { fill: COLORS.header, bold: true });

  [2, 3, 4].forEach((row) => {
    let total = 0;
    for (let col = firstDataCol; col < totalCol; col += 1) total += Number(sheet.getCell(row, col).value || 0);
    sheet.getCell(row, totalCol).value = total;
  });

  let rowIndex = 7;
  identities.forEach((identity) => {
    sheet.getCell(rowIndex, 1).value = identity;
    let rowTotal = 0;
    dates.forEach((date, dateIndex) => {
      roomTypes.forEach((roomType, typeIndex) => {
        const col = firstDataCol + dateIndex * roomTypes.length + typeIndex;
        const count = needs.filter((need) => needBelongsToIdentity(need, identity) && needStaysOnDate(need, date) && need.roomType === roomType).length;
        sheet.getCell(rowIndex, col).value = count || null;
        rowTotal += count;
      });
    });
    sheet.getCell(rowIndex, totalCol).value = rowTotal;
    styleRange(sheet, rowIndex, rowIndex, 1, totalCol, {});
    rowIndex += 1;
  });

  sheet.getCell(rowIndex, 1).value = "全部需求";
  let allTotal = 0;
  dates.forEach((date, dateIndex) => {
    roomTypes.forEach((roomType, typeIndex) => {
      const col = firstDataCol + dateIndex * roomTypes.length + typeIndex;
      const count = needsForDateAndType(needs, date, roomType).length;
      sheet.getCell(rowIndex, col).value = count;
      allTotal += count;
    });
  });
  sheet.getCell(rowIndex, totalCol).value = allTotal;
  styleRange(sheet, rowIndex, rowIndex, 1, totalCol, { fill: COLORS.total, bold: true });
  sheet.getRow(5).height = 24;
  sheet.getRow(6).height = 24;
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return sheet;
}

function addIdentitySheet(workbook, identity, needs, dates, roomTypes, capacities, sequenceByNeed) {
  const sheet = workbook.addWorksheet(identity, { views: [{ state: "frozen", xSplit: 10, ySplit: 5 }] });
  const detailHeaders = ["性质", "序号", "入住人姓名", "房间类型", "入住日期", "退房日期", "入住天数", "电话", "身份证号码", "性别"];
  const detailWidths = [12, 8, 16, 12, 12, 12, 10, 16, 23, 8];
  detailWidths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  const firstMatrixCol = detailHeaders.length + 1;
  const totalCol = firstMatrixCol + dates.length * roomTypes.length;
  for (let col = firstMatrixCol; col < totalCol; col += 1) sheet.getColumn(col).width = 8;
  sheet.getColumn(totalCol).width = 10;

  sheet.getCell(1, detailHeaders.length).value = "总数";
  sheet.getCell(2, detailHeaders.length).value = "使用";
  sheet.getCell(3, detailHeaders.length).value = "剩余";
  styleRange(sheet, 1, 3, detailHeaders.length, detailHeaders.length, { fill: COLORS.header, bold: true });

  dates.forEach((date, dateIndex) => {
    const startCol = firstMatrixCol + dateIndex * roomTypes.length;
    mergeHeader(sheet, 4, startCol, roomTypes.length, date, COLORS.title);
    roomTypes.forEach((roomType, typeIndex) => {
      const col = startCol + typeIndex;
      const available = totalCapacity(capacities, date, roomType);
      const used = needs.filter((need) => needBelongsToIdentity(need, identity) && needStaysOnDate(need, date) && need.roomType === roomType).length;
      sheet.getCell(1, col).value = available;
      sheet.getCell(2, col).value = used;
      sheet.getCell(3, col).value = available - used;
      sheet.getCell(5, col).value = roomType;
      applyCellStyle(sheet.getCell(5, col), { fill: roomTypeFill(roomType), bold: true });
    });
  });

  detailHeaders.forEach((header, index) => {
    sheet.getCell(5, index + 1).value = header;
    applyCellStyle(sheet.getCell(5, index + 1), { fill: COLORS.header, bold: true });
  });
  sheet.mergeCells(4, totalCol, 5, totalCol);
  sheet.getCell(4, totalCol).value = "总计";
  styleRange(sheet, 4, 5, totalCol, totalCol, { fill: COLORS.header, bold: true });

  [1, 2, 3].forEach((row) => {
    let total = 0;
    for (let col = firstMatrixCol; col < totalCol; col += 1) total += Number(sheet.getCell(row, col).value || 0);
    sheet.getCell(row, totalCol).value = total;
    applyCellStyle(sheet.getCell(row, totalCol), { fill: row === 1 ? COLORS.available : row === 2 ? COLORS.used : COLORS.remaining, bold: true });
  });

  let rowIndex = 6;
  needs.forEach((need) => {
    const matchingPeople = peopleForNeed(need).filter((person) => person.identity === identity);
    matchingPeople.forEach((person, personIndex) => {
      const row = sheet.getRow(rowIndex);
      row.height = 24;
      row.getCell(1).value = identity;
      row.getCell(2).value = sequenceByNeed.get(need.id);
      row.getCell(3).value = person.name || null;
      row.getCell(4).value = displayRoomType(need.roomType);
      setDateCell(row.getCell(5), need.checkIn);
      setDateCell(row.getCell(6), need.checkOut);
      if (personIndex === 0 && need.checkIn && need.checkOut) row.getCell(7).value = nightsBetween(need.checkIn, need.checkOut).length;
      setTextCell(row.getCell(8), person.phone);
      setTextCell(row.getCell(9), person.idNo);
      row.getCell(10).value = person.gender || null;

      let rowTotal = 0;
      if (personIndex === 0 && needBelongsToIdentity(need, identity)) {
        dates.forEach((date, dateIndex) => {
          roomTypes.forEach((roomType, typeIndex) => {
            const col = firstMatrixCol + dateIndex * roomTypes.length + typeIndex;
            const occupied = needStaysOnDate(need, date) && need.roomType === roomType;
            if (occupied) {
              row.getCell(col).value = 1;
              rowTotal += 1;
            }
          });
        });
      }
      row.getCell(totalCol).value = rowTotal || null;
      styleRange(sheet, rowIndex, rowIndex, 1, totalCol, {});
      rowIndex += 1;
    });
  });

  const totalRow = rowIndex;
  sheet.mergeCells(totalRow, 1, totalRow, detailHeaders.length);
  sheet.getCell(totalRow, 1).value = "合计";
  let grandTotal = 0;
  dates.forEach((date, dateIndex) => {
    roomTypes.forEach((roomType, typeIndex) => {
      const col = firstMatrixCol + dateIndex * roomTypes.length + typeIndex;
      const count = needs.filter((need) => needBelongsToIdentity(need, identity) && needStaysOnDate(need, date) && need.roomType === roomType).length;
      sheet.getCell(totalRow, col).value = count;
      grandTotal += count;
    });
  });
  sheet.getCell(totalRow, totalCol).value = grandTotal;
  styleRange(sheet, totalRow, totalRow, 1, totalCol, { fill: COLORS.total, bold: true });
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return sheet;
}

async function buildOverviewWorkbook(payload = {}) {
  const needs = sanitizeNeeds(payload.needs);
  if (!needs.length) throw new Error("当前没有可导出的住宿需求");
  const dates = datesForNeeds(needs, payload.dates);
  const roomTypes = roomTypesForNeeds(needs);
  const capacities = payload.roomCapacityTotals && typeof payload.roomCapacityTotals === "object" ? payload.roomCapacityTotals : {};
  const sequenceByNeed = new Map(needs.map((need, index) => [need.id, index + 1]));
  const identities = [...DEFAULT_IDENTITIES];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "活动房务系统";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  addTotalSheet(workbook, needs, sequenceByNeed);
  addSummarySheet(workbook, needs, dates, roomTypes, identities, capacities);
  identities.forEach((identity) => {
    const identityNeeds = needs.filter((need) => needContainsIdentity(need, identity));
    addIdentitySheet(workbook, identity, identityNeeds, dates, roomTypes, capacities, sequenceByNeed);
  });

  return workbook;
}

module.exports = {
  buildOverviewWorkbook,
  sanitizeNeeds,
  nightsBetween
};
