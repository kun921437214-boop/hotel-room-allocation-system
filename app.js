const storageKey = "hotelRoomOpsLocalSystem.v5.roomAvailability";
const syncApiUrl = window.HOTEL_ROOM_SYNC_API || "/api/state";
const workbookExportApiUrl = window.HOTEL_ROOM_WORKBOOK_EXPORT_API || "/api/export-workbook";
const uploadTaskStorageKey = `${storageKey}.pendingNeedUpload`;

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

let state = loadState();
let activeView = "dashboard";
let editing = null;
let remoteSyncReady = false;
let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let remoteOperationChain = Promise.resolve();
let remoteOperationPending = 0;
let localStateRevision = 0;
let needsRemoteSaveAfterLoad = false;
let uploadInProgress = false;
let remoteStateVersion = "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function defaultDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dateToValue(date);
}

function activeDates() {
  const needDates = Array.from(new Set(visibleNeeds().flatMap((need) => nightsBetween(need.checkIn, need.checkOut)))).sort();
  if (needDates.length) return needDates;
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
  markLocalStateChanged();
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

function markLocalStateChanged() {
  localStateRevision += 1;
  if (!remoteSyncReady) needsRemoteSaveAfterLoad = true;
}

async function loadRemoteState() {
  setSyncStatus("正在连接共享数据");
  try {
    const response = await fetch(syncApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.state) {
      state = payload.state;
      remoteStateVersion = payload.version || "";
      saveLocalStateOnly();
    }
    remoteSyncReady = true;
    needsRemoteSaveAfterLoad = false;
    saveQueued = false;
    clearTimeout(saveTimer);
    setSyncStatus("共享数据已同步", "ok");
    return true;
  } catch (error) {
    remoteSyncReady = false;
    setSyncStatus("本地模式，未连接共享数据", "bad");
    return false;
  }
}

function applyRemoteResult(result, shouldRender = true) {
  if (result?.version) remoteStateVersion = result.version;
  if (result?.state) {
    state = result.state;
    saveLocalStateOnly();
    if (shouldRender) render();
  }
}

function handleStaleRemoteResult(result) {
  applyRemoteResult(result, true);
  remoteSyncReady = true;
  saveQueued = false;
  setSyncStatus("共享数据已更新，请重新操作", "bad");
}

function scheduleRemoteSave() {
  if (!remoteSyncReady) return;
  saveQueued = true;
  clearTimeout(saveTimer);
  if (saveInFlight) return;
  saveTimer = setTimeout(syncStateToRemote, 450);
}

async function syncStateToRemote() {
  if (!remoteSyncReady || saveInFlight || !saveQueued) return;
  const startedAtRevision = localStateRevision;
  saveQueued = false;
  saveInFlight = true;
  setSyncStatus("正在保存共享数据");
  try {
    const response = await fetch(syncApiUrl, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ state, baseVersion: remoteStateVersion })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result?.stale) {
      handleStaleRemoteResult(result);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (result?.version) remoteStateVersion = result.version;
    if (result?.state && startedAtRevision === localStateRevision) {
      applyRemoteResult(result, true);
    }
    remoteSyncReady = true;
    setSyncStatus("共享数据已保存", "ok");
  } catch (error) {
    remoteSyncReady = false;
    setSyncStatus("保存失败，已保存在本机", "bad");
  } finally {
    saveInFlight = false;
    if (remoteSyncReady && saveQueued) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(syncStateToRemote, 0);
    }
  }
}

function queueRemoteOperation(payload) {
  if (!remoteSyncReady) return;
  remoteOperationPending += 1;
  setSyncStatus("正在保存共享数据");
  remoteOperationChain = remoteOperationChain
    .catch(() => {})
    .then(() => syncOperationToRemote(payload))
    .finally(() => {
      remoteOperationPending = Math.max(0, remoteOperationPending - 1);
    });
}

async function syncOperationToRemote(payload) {
  if (!remoteSyncReady) return;
  try {
    const response = await fetch(syncApiUrl, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...payload, baseVersion: remoteStateVersion })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result?.stale) {
      handleStaleRemoteResult(result);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (result?.version) remoteStateVersion = result.version;
    if (result?.state && remoteOperationPending <= 1) {
      applyRemoteResult(result, true);
    }
    remoteSyncReady = true;
    setSyncStatus("共享数据已保存", "ok");
  } catch (error) {
    remoteSyncReady = false;
    setSyncStatus("保存失败，已保存在本机", "bad");
  }
}

function saveNeedState(need, meta = {}) {
  markLocalStateChanged();
  saveLocalStateOnly();
  queueRemoteOperation({
    action: "upsertNeed",
    need,
    operationType: meta.operationType,
    operationDescription: meta.operationDescription,
    batchId: need.uploadBatchId || ""
  });
}

function saveNeedsState(needs, meta = {}) {
  markLocalStateChanged();
  saveLocalStateOnly();
  queueRemoteOperation({
    action: "upsertNeeds",
    needs,
    operationType: meta.operationType,
    operationDescription: meta.operationDescription,
    batchId: meta.batchId || ""
  });
}

function deleteNeedState(needId, meta = {}) {
  markLocalStateChanged();
  saveLocalStateOnly();
  queueRemoteOperation({
    action: "deleteNeed",
    needId,
    operationType: meta.operationType,
    operationDescription: meta.operationDescription,
    batchId: meta.batchId || ""
  });
}

function randomToken(length = 8) {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
  }
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, "0");
}

function uploadTaskId() {
  return `UPLOAD-${dateToValue(new Date()).replaceAll("-", "")}-${Date.now().toString(36)}-${randomToken(5)}`;
}

function uploadBatchName(createdAt = new Date().toISOString()) {
  const date = createdAt.slice(0, 10);
  const time = createdAt.slice(11, 16);
  return `${date} ${time} 上传批次`;
}

function uploadNeedId(taskId, index) {
  return `REQ-${taskId.replace("UPLOAD-", "")}-${String(index + 1).padStart(3, "0")}-${randomToken(4)}`;
}

function peopleCountForNeeds(needs) {
  return needs.reduce((sum, need) => sum + peopleForNeed(need).length, 0);
}

function createNeedUploadTask(needs) {
  const id = uploadTaskId();
  const createdAt = new Date().toISOString();
  const batchName = uploadBatchName(createdAt);
  return {
    id,
    batchName,
    createdAt,
    nextIndex: 0,
    total: needs.length,
    peopleTotal: peopleCountForNeeds(needs),
    needs: needs.map((need, index) => ({
      ...need,
      id: uploadNeedId(id, index),
      uploadBatchId: id,
      uploadBatchName: batchName,
      uploadBatchTime: createdAt,
      companions: Array.isArray(need.companions) ? need.companions : []
    }))
  };
}

function savePendingUploadTask(task) {
  localStorage.setItem(uploadTaskStorageKey, JSON.stringify(task));
}

function loadPendingUploadTask() {
  const stored = localStorage.getItem(uploadTaskStorageKey);
  if (!stored) return null;
  try {
    const task = JSON.parse(stored);
    return task?.needs?.length ? task : null;
  } catch {
    return null;
  }
}

function clearPendingUploadTask() {
  localStorage.removeItem(uploadTaskStorageKey);
}

function pendingUploadNeedIdSet() {
  const task = loadPendingUploadTask();
  return new Set((task?.needs || []).map((need) => need.id).filter(Boolean));
}

function isPendingUploadNeed(need) {
  if (!need?.id) return false;
  return pendingUploadNeedIdSet().has(need.id);
}

function visibleNeeds() {
  const pendingIds = pendingUploadNeedIdSet();
  if (!pendingIds.size) return state.needs;
  return state.needs.filter((need) => !pendingIds.has(need.id));
}

function pendingTaskIsAlreadyInSharedState(task) {
  const total = task.total || task.needs?.length || 0;
  const savedIds = new Set((state.needs || []).map((need) => need.id).filter(Boolean));
  const taskIds = (task.needs || []).map((need) => need.id).filter(Boolean);
  return taskIds.length === total && taskIds.every((id) => savedIds.has(id));
}

function setUploadProgress(text = "", type = "") {
  const progress = $("#uploadProgress");
  if (!progress) return;
  progress.hidden = !text;
  progress.textContent = text;
  progress.className = ["upload-progress", type].filter(Boolean).join(" ");
}

function uploadTaskMeta(task) {
  const saved = Math.min(task.nextIndex || 0, task.total || task.needs?.length || 0);
  const remaining = Math.max(0, (task.total || task.needs?.length || 0) - saved);
  return [
    `<span>上传批次：${escapeHtml(task.batchName || task.id || "")}</span>`,
    `<span>总需求：${task.total || task.needs?.length || 0} 条</span>`,
    `<span>总人数：${task.peopleTotal || peopleCountForNeeds(task.needs || [])} 人</span>`,
    `<span>已保存：${saved} 条</span>`,
    `<span>剩余：${remaining} 条</span>`
  ].join("");
}

function showUploadDialog({ title, message, meta = "", primaryText = "继续上传", secondaryText = "取消上传", hideSecondary = false }) {
  return new Promise((resolve) => {
    const dialog = $("#uploadDialog");
    const primary = $("#uploadPrimaryBtn");
    const secondary = $("#uploadSecondaryBtn");
    $("#uploadDialogTitle").textContent = title;
    $("#uploadDialogMessage").textContent = message;
    $("#uploadDialogMeta").innerHTML = meta;
    primary.textContent = primaryText;
    secondary.textContent = secondaryText;
    secondary.hidden = hideSecondary;

    const cleanup = (value) => {
      primary.removeEventListener("click", onPrimary);
      secondary.removeEventListener("click", onSecondary);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onPrimary = () => cleanup("primary");
    const onSecondary = () => cleanup("secondary");
    const onCancel = (event) => {
      event.preventDefault();
      if (!hideSecondary) cleanup("secondary");
    };
    primary.addEventListener("click", onPrimary);
    secondary.addEventListener("click", onSecondary);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

async function syncUploadPayload(payload) {
  const shouldCheckVersion = payload.action === "upsertNeeds";
  const response = await fetch(syncApiUrl, {
    method: "PUT",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(shouldCheckVersion ? { ...payload, baseVersion: remoteStateVersion } : payload)
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409 && result?.stale) {
    handleStaleRemoteResult(result);
    throw new Error("共享数据已被其他人更新，请重新选择文件上传。");
  }
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `HTTP ${response.status}`);
  }
  if (result?.version) remoteStateVersion = result.version;
  return result;
}

async function ensureRemoteForUpload() {
  if (remoteSyncReady) return;
  const loaded = await loadRemoteState();
  if (!loaded) throw new Error("共享数据未连接，请稍后再试。");
}

async function refreshSharedStateAfterUpload() {
  const result = await syncUploadPayload({ action: "cleanupDuplicates" });
  if (result?.state) {
    state = result.state;
    saveLocalStateOnly();
    render();
  }
  remoteSyncReady = true;
  setSyncStatus("共享数据已保存", "ok");
}

async function uploadNeedTaskOnce(task) {
  await ensureRemoteForUpload();
  uploadInProgress = true;
  savePendingUploadTask(task);
  setUploadProgress(`上传 0 / ${task.total}`);
  setSyncStatus("正在批量保存共享数据");
  const result = await syncUploadPayload({
    action: "upsertNeeds",
    needs: task.needs,
    batchId: task.id,
    batchName: task.batchName,
    uploadBatchTime: task.createdAt,
    operationType: "批量上传需求",
    operationDescription: `${task.batchName || task.id} 上传 ${task.total} 条住宿需求，${task.peopleTotal} 人`
  });
  task.nextIndex = task.total;
  savePendingUploadTask(task);
  setUploadProgress(`上传 ${task.nextIndex} / ${task.total}`);
  if (result?.state) {
    applyRemoteResult(result, true);
  }
  clearPendingUploadTask();
  render();
  setUploadProgress(`完成 ${task.total} / ${task.total}`, "done");
  setTimeout(() => {
    if (!loadPendingUploadTask()) setUploadProgress("");
  }, 2500);
  uploadInProgress = false;
}

async function rollbackUploadTask(task) {
  const ids = (task.needs || []).map((need) => need.id).filter(Boolean);
  await ensureRemoteForUpload();
  setUploadProgress(`正在取消 ${ids.length} / ${ids.length}`);
  const result = await syncUploadPayload({
    action: "deleteNeeds",
    needIds: ids,
    batchId: task.id,
    operationType: "撤回上传批次",
    operationDescription: `${task.batchName || task.id} 撤回 ${ids.length} 条住宿需求`
  });
  if (result?.state) {
    applyRemoteResult(result, true);
  }
  clearPendingUploadTask();
  setUploadProgress("");
}

async function runNeedUploadTask(task) {
  while (task) {
    try {
      await uploadNeedTaskOnce(task);
      await showUploadDialog({
        title: "上传完成",
        message: `已全部保存完成，共 ${task.total} 条住宿需求，${task.peopleTotal} 人。`,
        meta: uploadTaskMeta({ ...task, nextIndex: task.total }),
        primaryText: "知道了",
        hideSecondary: true
      });
      return;
    } catch (error) {
      uploadInProgress = false;
      savePendingUploadTask(task);
      const allUploaded = task.nextIndex >= task.total;
      setUploadProgress(`${allUploaded ? "确认中断" : "上传中断"} ${task.nextIndex} / ${task.total}`, "bad");
      const action = await showUploadDialog({
        title: allUploaded ? "数据确认中断" : "上传中断",
        message: allUploaded
          ? `本次 ${task.total} 条住宿需求已经保存完成，但最后确认共享数据时中断。可以重新确认，或取消并撤回本次上传内容。${error.message ? `原因：${error.message}` : ""}`
          : `本次上传已保存 ${task.nextIndex} / ${task.total} 条。可以继续从断点上传，或取消并撤回本次已保存内容。${error.message ? `原因：${error.message}` : ""}`,
        meta: uploadTaskMeta(task),
        primaryText: allUploaded ? "重新确认数据" : "继续上传",
        secondaryText: "取消上传"
      });
      if (action === "primary") continue;
      try {
        await rollbackUploadTask(task);
        await showUploadDialog({
          title: "已取消上传",
          message: "本次上传已取消，系统已尝试撤回本次已保存的内容。",
          primaryText: "知道了",
          hideSecondary: true
        });
      } catch (rollbackError) {
        await showUploadDialog({
          title: "取消上传失败",
          message: `系统没有完全撤回本次上传内容，请稍后刷新检查。原因：${rollbackError.message || "未知错误"}`,
          primaryText: "知道了",
          hideSecondary: true
        });
      }
      return;
    }
  }
}

async function resumePendingUploadIfNeeded() {
  const task = loadPendingUploadTask();
  if (!task || uploadInProgress) return;
  if (pendingTaskIsAlreadyInSharedState(task)) {
    clearPendingUploadTask();
    setUploadProgress("");
    render();
    return;
  }
  const total = task.total || task.needs.length;
  const allUploaded = (task.nextIndex || 0) >= total;
  setUploadProgress(`${allUploaded ? "待确认" : "未完成"} ${task.nextIndex || 0} / ${total}`, "bad");
  const action = await showUploadDialog({
    title: allUploaded ? "发现待确认数据" : "发现未完成上传",
    message: allUploaded
      ? "上次批量上传的数据已经保存完成，但最后确认共享数据时中断。可以重新确认，也可以取消并撤回本次上传内容。"
      : "上次批量上传还没有全部保存完成，可以从断点继续，也可以取消并撤回本次上传内容。",
    meta: uploadTaskMeta(task),
    primaryText: allUploaded ? "重新确认数据" : "继续上传",
    secondaryText: "取消上传"
  });
  if (action === "primary") {
    await runNeedUploadTask(task);
    return;
  }
  try {
    await rollbackUploadTask(task);
    await showUploadDialog({
      title: "已取消上传",
      message: "未完成上传已取消，系统已尝试撤回本次已保存的内容。",
      primaryText: "知道了",
      hideSecondary: true
    });
  } catch (error) {
    await showUploadDialog({
      title: "取消上传失败",
      message: `系统没有完全撤回本次上传内容，请稍后刷新检查。原因：${error.message || "未知错误"}`,
      primaryText: "知道了",
      hideSecondary: true
    });
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
  if (hotel === "汉庭酒店" || hotel === "汉庭") return "诺富特";
  if (hotel === "如家酒店" || hotel === "如家") return "宜必思";
  if (hotel === "万豪酒店" || hotel === "万豪") return "施柏阁";
  if (hotel === "诺富特酒店") return "诺富特";
  if (hotel === "宜必思酒店") return "宜必思";
  if (hotel === "施柏阁酒店") return "施柏阁";
  if (hotel === "大观酒店") return "大观";
  return hotel || "";
}

function needHotels() {
  const names = new Set([...arrangementHotelOptions, ...visibleNeeds().map((need) => normalizedNeedHotel(need.hotel)).filter(Boolean)]);
  return Array.from(names);
}

function roomCapacityHotels() {
  const names = new Set([...arrangementHotelOptions, ...Object.keys(roomCapacityTotals), ...needHotels()]);
  return Array.from(names).filter(Boolean);
}

function personIdentity(person, fallback = "") {
  return person?.identity || fallback || "其他";
}

function roleIdentities() {
  const names = new Set(identityOptions);
  visibleNeeds().forEach((need) => {
    peopleForNeed(need).forEach((person) => names.add(personIdentity(person, need.identity)));
  });
  return Array.from(names).filter(Boolean);
}

function needMatchesIdentity(need, identity = "all") {
  return identity === "all" || peopleForNeed(need).some((person) => personIdentity(person, need.identity) === identity);
}

function needMatchesHotel(need, hotel = "all") {
  return hotel === "all" || normalizedNeedHotel(need.hotel) === hotel;
}

function needStaysOnDate(date, hotel = "all", identity = "all") {
  return visibleNeeds().filter((need) => (
    need.checkIn &&
    need.checkOut &&
    date >= need.checkIn &&
    date < need.checkOut &&
    needMatchesHotel(need, hotel) &&
    needMatchesIdentity(need, identity) &&
    filteredText(need).includes(getSearch())
  ));
}

function roleNeedsOnDate(date, identity = "all", hotel = "all") {
  return visibleNeeds().filter((need) => (
    need.checkIn &&
    need.checkOut &&
    date >= need.checkIn &&
    date < need.checkOut &&
    needMatchesIdentity(need, identity) &&
    needMatchesHotel(need, hotel) &&
    filteredText(need).includes(getSearch())
  ));
}

function roomBalanceNeedsOnDate(date, hotel = "all") {
  return visibleNeeds().filter((need) => (
    need.checkIn &&
    need.checkOut &&
    date >= need.checkIn &&
    date < need.checkOut &&
    needMatchesHotel(need, hotel) &&
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
  const visibleTypes = [...roomTypeOptions, ...extraTypes].filter((type) => (counts[type] || 0) > 0);
  if (!visibleTypes.length) return `<div class="room-type-count-line room-type-empty">暂无</div>`;
  return visibleTypes.map((type) => (
    `<div class="room-type-count-line ${roomTypeCountClass(type)}">${escapeHtml(type)}：${counts[type] || 0}间</div>`
  )).join("");
}

function roomCapacityTotal(hotel, date, type) {
  const normalizedHotel = normalizedNeedHotel(hotel);
  const normalizedType = normalizedRoomType(type);
  return Number(roomCapacityTotals[normalizedHotel]?.[date]?.[normalizedType] || 0);
}

function roomBalanceInfo(date, hotel, type) {
  const counts = needTypeCounts(roomBalanceNeedsOnDate(date, hotel));
  const used = counts[normalizedRoomType(type)] || 0;
  const total = roomCapacityTotal(hotel, date, type);
  return { used, total, remaining: total - used };
}

function roomBalanceCountLines(date, hotel) {
  const counts = needTypeCounts(roomBalanceNeedsOnDate(date, hotel));
  const extraTypes = Object.keys(counts).filter((type) => !roomTypeOptions.includes(type));
  const visibleTypes = [...roomTypeOptions, ...extraTypes].filter((type) => roomCapacityTotal(hotel, date, type) > 0 || (counts[type] || 0) > 0);
  if (!visibleTypes.length) return `<div class="room-type-count-line room-type-empty">暂无</div>`;
  return visibleTypes.map((type) => {
    const { remaining, total } = roomBalanceInfo(date, hotel, type);
    return `<div class="room-type-count-line ${roomTypeCountClass(type)}">${escapeHtml(type)}：${remaining}/${total}</div>`;
  }).join("");
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

function personText(person) {
  return [person.name, person.gender, person.phone, person.idNo, person.identity].filter(Boolean).join(" ");
}

function needSearchText(need) {
  const peopleText = peopleForNeed(need).map(personText).join(" ");
  return [
    peopleText,
    need.checkIn,
    need.checkOut,
    need.hotel,
    need.roomNo,
    need.roomType,
    need.note,
    need.owner
  ].filter(Boolean).join(" ").toLowerCase();
}

function currentFilteredNeeds() {
  const search = getSearch();
  const hotel = $("#needHotelFilter")?.value || "all";
  const identity = $("#needIdentityFilter")?.value || "all";
  return visibleNeeds().filter((need) => (
    needSearchText(need).includes(search) &&
    needMatchesHotel(need, hotel) &&
    needMatchesIdentity(need, identity)
  ));
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

function validateOptionalStayDates(checkIn, checkOut, prefix = "") {
  const label = prefix ? `${prefix} ` : "";
  if (!checkIn && !checkOut) return;
  if (!checkIn || !checkOut) {
    throw new Error(`${label}入住日期和离店日期需要同时填写，或同时留空`);
  }
  if (checkIn >= checkOut) {
    throw new Error(`${label}离店日期必须晚于入住日期`);
  }
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
const needBatchHeaders = ["序号", "姓名", "性别", "电话", "身份证号", "人员性质", "安排酒店", "房间类型", "房间号", "入住日期", "离店日期", "备注"];
const identityOptions = ["工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"];
const arrangementHotelOptions = ["诺富特", "宜必思", "施柏阁", "大观"];
const defaultHotelInfoRange = { start: "2026-07-29", end: "2026-08-06" };
const roomCapacityDates = [
  "2026-07-29",
  "2026-07-30",
  "2026-07-31",
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06"
];
const roomCapacityTotals = Object.fromEntries(arrangementHotelOptions.map((hotel) => [
  hotel,
  Object.fromEntries(roomCapacityDates.map((date) => [
    date,
    { "双标": 100, "大床": 100, "套房": 100 }
  ]))
]));

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

async function exportOverviewWorkbook() {
  const needs = visibleNeeds();
  if (!needs.length) {
    alert("当前没有可导出的住宿需求。");
    return;
  }
  const button = $("#exportOverviewWorkbookBtn");
  const originalText = button?.textContent || "导出工作总表";
  if (button) {
    button.disabled = true;
    button.textContent = "正在生成...";
  }
  try {
    const response = await fetch(workbookExportApiUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        needs,
        dates: activeDates(),
        roomCapacityTotals
      })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `活动住宿工作总表-${dateToValue(new Date())}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(`导出失败：${error.message || "请稍后重试"}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function downloadRoomTemplate() {
  const rows = [
    roomBatchHeaders,
    ["诺富特", "1001", "1", "双标", "2", "2026-08-01", "2026-08-06", "未分配"],
    ["宜必思", "2001", "2", "大床", "2", "2026-08-01", "2026-08-06", "备用"]
  ];
  const tableHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${tableHtml}</table></body></html>`;
  downloadBlob("酒店房间批量上传模板.xls", html, "application/vnd.ms-excel;charset=utf-8");
}

function downloadNeedTemplate() {
  const rows = [
    needBatchHeaders,
    ["1", "姓名1", "男", "手机号1", "身份证号1", "工作人员", "诺富特", "双标", "1001", "2026/8/1", "2026/8/6", "房间大一点"],
    ["1", "姓名2", "男", "手机号2", "身份证号2", "工作人员", "诺富特", "双标", "1001", "2026/8/1", "2026/8/6", "房间大一点"],
    ["2", "姓名3", "女", "手机号3", "身份证号3", "评委", "施柏阁", "大床", "2001", "2026/8/2", "2026/8/5", "需要安静"]
  ];
  const tableHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${tableHtml}</table></body></html>`;
  downloadBlob("入住需求批量上传模板.xls", html, "application/vnd.ms-excel;charset=utf-8");
}

function excelCellHtml(cell) {
  const value = typeof cell === "object" && cell !== null ? cell.value : cell;
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function excelCellAttributes(cell) {
  if (typeof cell !== "object" || cell === null) return "";
  return [
    cell.colspan ? ` colspan="${cell.colspan}"` : "",
    cell.rowspan ? ` rowspan="${cell.rowspan}"` : "",
    cell.className ? ` class="${escapeHtml(cell.className)}"` : ""
  ].join("");
}

function downloadStyledTable(filename, rows) {
  const tableHtml = rows.map((row, rowIndex) => {
    return `<tr>${row.map((cell) => {
      const isHeader = rowIndex === 0 || (typeof cell === "object" && cell !== null && cell.header);
      const tag = isHeader ? "th" : "td";
      return `<${tag}${excelCellAttributes(cell)}>${excelCellHtml(cell)}</${tag}>`;
    }).join("")}</tr>`;
  }).join("");
  const styles = `
    <style>
      table { border-collapse: collapse; font-family: Arial, "Microsoft YaHei", sans-serif; font-size: 12pt; }
      th, td { border: 1px solid #333; padding: 8px 10px; text-align: center; vertical-align: middle; mso-number-format: "\\@"; white-space: normal; }
      th { background: #f2f4f7; font-weight: 700; }
    </style>
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8">${styles}</head><body><table>${tableHtml}</table></body></html>`;
  downloadBlob(filename, html, "application/vnd.ms-excel;charset=utf-8");
}

function worksheetName(name, usedNames) {
  const base = String(name || "工作表").replace(/[\\/:?*\[\]]/g, " ").slice(0, 31).trim() || "工作表";
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function workbookCellXml(cell, rowIndex) {
  const isCellObject = typeof cell === "object" && cell !== null;
  const isHeader = rowIndex === 0 || (isCellObject && cell.header);
  const isNumber = isCellObject && cell.number === true;
  const value = isCellObject ? cell.value : cell;
  const styleId = isHeader ? "Header" : (isNumber ? "Number" : "Cell");
  const attributes = [
    isCellObject && cell.index ? `ss:Index="${Number(cell.index)}"` : "",
    isCellObject && cell.colspan ? `ss:MergeAcross="${Number(cell.colspan) - 1}"` : "",
    isCellObject && cell.rowspan ? `ss:MergeDown="${Number(cell.rowspan) - 1}"` : "",
    `ss:StyleID="${styleId}"`
  ].filter(Boolean).join(" ");
  return `<Cell ${attributes}><Data ss:Type="${isNumber ? "Number" : "String"}">${escapeHtml(value)}</Data></Cell>`;
}

function downloadStyledWorkbook(filename, sheets) {
  const usedNames = new Set();
  const worksheetXml = sheets.map((sheet) => {
    const rows = sheet.rows.map((row, rowIndex) => (
      `<Row>${row.map((cell) => workbookCellXml(cell, rowIndex)).join("")}</Row>`
    )).join("");
    return `
      <Worksheet ss:Name="${escapeHtml(worksheetName(sheet.name, usedNames))}">
        <Table>${rows}</Table>
      </Worksheet>
    `;
  }).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <?mso-application progid="Excel.Sheet"?>
    <Workbook
      xmlns="urn:schemas-microsoft-com:office:spreadsheet"
      xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
      xmlns:html="http://www.w3.org/TR/REC-html40">
      <Styles>
        <Style ss:ID="Cell">
          <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
          <Borders>
            <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
          </Borders>
          <NumberFormat ss:Format="@"/>
        </Style>
        <Style ss:ID="Header">
          <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
          <Borders>
            <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
          </Borders>
          <Font ss:Bold="1"/>
          <Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/>
          <NumberFormat ss:Format="@"/>
        </Style>
        <Style ss:ID="Number">
          <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
          <Borders>
            <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
            <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
          </Borders>
          <NumberFormat ss:Format="#,##0"/>
        </Style>
      </Styles>
      ${worksheetXml}
    </Workbook>`;
  downloadBlob(filename, xml, "application/vnd.ms-excel;charset=utf-8");
}

function exportCurrentNeeds() {
  const needs = currentFilteredNeeds();
  if (!needs.length) {
    alert("当前搜索条件下没有可导出的入住需求。");
    return;
  }
  const headers = ["序号", "姓名", "性别", "电话", "身份证号", "人员性质", "入住日期", "离店日期", "入住天数", "安排酒店", "房间号", "房间类型", "备注"];
  const rows = [headers];
  needs.forEach((need, index) => {
    peopleForNeed(need).forEach((person, personIndex) => {
      rows.push([
        String(index + 1),
        person.name || "",
        person.gender || "",
        person.phone || "",
        person.idNo || "",
        person.identity || "",
        need.checkIn || "",
        need.checkOut || "",
        personIndex === 0 ? { value: needNightCount(need), number: true } : "",
        need.hotel || "",
        need.roomNo || "",
        need.roomType || "",
        need.note || ""
      ]);
    });
  });
  downloadStyledWorkbook(`入住需求当前名单-${dateToValue(new Date())}.xls`, [{ name: "入住需求", rows }]);
}

function dateRangeValues(startSelector, endSelector, fallbackStart = defaultHotelInfoRange.start, fallbackEnd = defaultHotelInfoRange.end) {
  const checkIn = $(startSelector)?.value || fallbackStart;
  const checkOut = $(endSelector)?.value || fallbackEnd;
  return checkIn <= checkOut ? nightsBetween(checkIn, addDays(checkOut, 1)) : [];
}

function statsExportRoomTypes(rowsByDate) {
  const counts = rowsByDate.flatMap((items) => Object.keys(needTypeCounts(items)));
  const extraTypes = Array.from(new Set(counts.filter((type) => !roomTypeOptions.includes(type))));
  return [...roomTypeOptions, ...extraTypes];
}

function statsExportHeaderRows(firstColumnLabel, dates, roomTypes) {
  return [
    [
      { value: firstColumnLabel, rowspan: 2, header: true },
      ...dates.map((date) => ({ value: date, colspan: roomTypes.length, header: true })),
      { value: "总计", rowspan: 2, header: true }
    ],
    dates.flatMap((date, dateIndex) => roomTypes.map((type, typeIndex) => ({
      value: type,
      header: true,
      index: dateIndex === 0 && typeIndex === 0 ? 2 : undefined
    })))
  ];
}

function statsExportCells(needs, roomTypes) {
  const counts = needTypeCounts(needs);
  const total = roomTypes.reduce((sum, type) => sum + (counts[type] || 0), 0);
  if (!total) return roomTypes.map((_, index) => (index === 0 ? "暂无" : ""));
  return roomTypes.map((type) => (counts[type] ? { value: counts[type], number: true } : ""));
}

function buildStatsExportRows(firstColumnLabel, labels, dates, getNeeds) {
  const data = labels.map((label) => ({
    label,
    byDate: dates.map((date) => getNeeds(label, date))
  }));
  const roomTypes = statsExportRoomTypes(data.flatMap((row) => row.byDate));
  const columnTotals = dates.flatMap(() => roomTypes.map(() => 0));
  const rows = statsExportHeaderRows(firstColumnLabel, dates, roomTypes);
  data.forEach((row) => {
    let rowTotal = 0;
    const cells = row.byDate.flatMap((needs, dateIndex) => {
      const counts = needTypeCounts(needs);
      roomTypes.forEach((type, typeIndex) => {
        const count = counts[type] || 0;
        columnTotals[dateIndex * roomTypes.length + typeIndex] += count;
        rowTotal += count;
      });
      return statsExportCells(needs, roomTypes);
    });
    rows.push([row.label, ...cells, { value: rowTotal, number: true }]);
  });
  rows.push([
    { value: "总计", header: true },
    ...columnTotals.map((count) => ({ value: count, number: true })),
    { value: columnTotals.reduce((sum, count) => sum + count, 0), number: true }
  ]);
  return rows;
}

function exportHotelStats() {
  const selectedIdentity = $("#calendarIdentity").value || "all";
  const dates = dateRangeValues("#calendarStartInput", "#calendarEndInput", activeDates()[0] || defaultDate(), activeDates()[0] || defaultDate());
  const hotels = needHotels();
  if (!dates.length || !hotels.length) {
    alert("当前筛选条件下没有可导出的酒店统计。");
    return;
  }
  const sheets = [
    {
      name: selectedIdentity === "all" ? "全部" : selectedIdentity,
      rows: buildStatsExportRows("酒店", hotels, dates, (hotel, date) => needStaysOnDate(date, hotel, selectedIdentity))
    }
  ];
  if (selectedIdentity === "all") {
    roleIdentities().forEach((identity) => {
      sheets.push({
        name: identity,
        rows: buildStatsExportRows("酒店", hotels, dates, (hotel, date) => needStaysOnDate(date, hotel, identity))
      });
    });
  }
  downloadStyledWorkbook(`酒店统计当前信息-${dateToValue(new Date())}.xls`, sheets);
}

function exportRoleStats() {
  const selectedHotel = $("#roleHotel").value || "all";
  const dates = dateRangeValues("#roleStartInput", "#roleEndInput");
  const identities = roleIdentities();
  if (!dates.length || !identities.length) {
    alert("当前筛选条件下没有可导出的角色统计。");
    return;
  }
  const sheets = [
    {
      name: selectedHotel === "all" ? "全部" : selectedHotel,
      rows: buildStatsExportRows("人员性质", identities, dates, (identity, date) => roleNeedsOnDate(date, identity, selectedHotel))
    }
  ];
  if (selectedHotel === "all") {
    needHotels().forEach((hotel) => {
      sheets.push({
        name: hotel,
        rows: buildStatsExportRows("人员性质", identities, dates, (identity, date) => roleNeedsOnDate(date, identity, hotel))
      });
    });
  }
  downloadStyledWorkbook(`角色统计当前信息-${dateToValue(new Date())}.xls`, sheets);
}

function roomBalanceExportRoomTypes(hotels, dates) {
  const usedTypes = hotels.flatMap((hotel) => dates.flatMap((date) => Object.keys(needTypeCounts(roomBalanceNeedsOnDate(date, hotel)))));
  const capacityTypes = hotels.flatMap((hotel) => dates.flatMap((date) => Object.keys(roomCapacityTotals[normalizedNeedHotel(hotel)]?.[date] || {})));
  const extraTypes = Array.from(new Set([...usedTypes, ...capacityTypes].filter((type) => !roomTypeOptions.includes(type))));
  return [...roomTypeOptions, ...extraTypes];
}

function buildRoomBalanceExportRows(hotels, dates) {
  const roomTypes = roomBalanceExportRoomTypes(hotels, dates);
  const columnTotals = dates.flatMap(() => roomTypes.map(() => 0));
  const rows = statsExportHeaderRows("酒店", dates, roomTypes);
  hotels.forEach((hotel) => {
    let rowTotal = 0;
    const cells = dates.flatMap((date, dateIndex) => roomTypes.map((type, typeIndex) => {
      const { remaining, total, used } = roomBalanceInfo(date, hotel, type);
      if (total <= 0 && used <= 0) return "";
      columnTotals[dateIndex * roomTypes.length + typeIndex] += remaining;
      rowTotal += remaining;
      return { value: remaining, number: true };
    }));
    rows.push([hotel, ...cells, { value: rowTotal, number: true }]);
  });
  rows.push([
    { value: "总计", header: true },
    ...columnTotals.map((count) => ({ value: count, number: true })),
    { value: columnTotals.reduce((sum, count) => sum + count, 0), number: true }
  ]);
  return rows;
}

function exportRoomBalance() {
  const selectedHotel = $("#balanceHotel").value || "all";
  const dates = dateRangeValues("#balanceStartInput", "#balanceEndInput");
  const hotels = roomCapacityHotels().filter((hotel) => selectedHotel === "all" || hotel === selectedHotel);
  if (!dates.length || !hotels.length) {
    alert("当前筛选条件下没有可导出的房间余量。");
    return;
  }
  downloadStyledWorkbook(`房间余量当前信息-${dateToValue(new Date())}.xls`, [{
    name: selectedHotel === "all" ? "全部" : selectedHotel,
    rows: buildRoomBalanceExportRows(hotels, dates)
  }]);
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

function rowsToBatchRecords(rows) {
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

function parseRoomBatchRows(text) {
  const rows = /<table[\s>]/i.test(text) ? parseHtmlTable(text) : parseCsv(text);
  return rowsToBatchRecords(rows);
}

function columnNameToIndex(name) {
  return String(name || "").toUpperCase().split("").reduce((sum, char) => (
    sum * 26 + char.charCodeAt(0) - 64
  ), 0) - 1;
}

function xmlChildren(node, tagName) {
  return Array.from(node.getElementsByTagName(tagName));
}

function xmlTextContent(node, tagName) {
  const item = xmlChildren(node, tagName)[0];
  return item ? item.textContent || "" : "";
}

function normalizeXlsxPath(target) {
  const text = String(target || "").replace(/^\/+/, "");
  if (text.startsWith("xl/")) return text;
  return `xl/${text}`.replaceAll("/./", "/");
}

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("没有找到有效的 xlsx 文件结构。");
}

function readZipDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      method,
      data: bytes.slice(dataStart, dataStart + compressedSize)
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data) {
  if (!window.DecompressionStream) {
    throw new Error("当前浏览器不支持直接读取 xlsx，请使用新版 Chrome 或上传 xls/csv。");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipEntryText(entries, path) {
  const entry = entries.get(path);
  if (!entry) return "";
  let data = entry.data;
  if (entry.method === 8) data = await inflateRaw(data);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error("暂不支持这个 xlsx 文件的压缩格式。");
  }
  return new TextDecoder().decode(data);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return xmlChildren(doc, "si").map((item) => (
    xmlChildren(item, "t").map((textNode) => textNode.textContent || "").join("")
  ));
}

async function xlsxWorksheetPath(entries, preferredNames = ["上传需求汇总"]) {
  const workbookXml = await zipEntryText(entries, "xl/workbook.xml");
  const relsXml = await zipEntryText(entries, "xl/_rels/workbook.xml.rels");
  const workbookDoc = new DOMParser().parseFromString(workbookXml, "application/xml");
  const relsDoc = new DOMParser().parseFromString(relsXml, "application/xml");
  const rels = new Map(xmlChildren(relsDoc, "Relationship").map((rel) => [
    rel.getAttribute("Id"),
    normalizeXlsxPath(rel.getAttribute("Target"))
  ]));
  const sheets = xmlChildren(workbookDoc, "sheet").map((sheet) => ({
    name: sheet.getAttribute("name") || "",
    relId: sheet.getAttribute("r:id") || sheet.getAttribute("id") || ""
  }));
  const preferred = sheets.find((sheet) => preferredNames.includes(sheet.name)) || sheets.find((sheet) => sheet.name !== "检查结果") || sheets[0];
  const path = rels.get(preferred?.relId);
  if (!path) throw new Error("没有找到 xlsx 里的工作表。");
  return path;
}

function xlsxCellValue(cell, sharedStrings) {
  const type = cell.getAttribute("t") || "";
  const rawValue = xmlTextContent(cell, "v");
  if (type === "s") return sharedStrings[Number(rawValue)] || "";
  if (type === "inlineStr") return xmlChildren(cell, "t").map((item) => item.textContent || "").join("");
  if (type === "b") return rawValue === "1" ? "TRUE" : "FALSE";
  return rawValue || "";
}

function parseWorksheetRows(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return xmlChildren(doc, "row").map((row) => {
    const values = [];
    xmlChildren(row, "c").forEach((cell, fallbackIndex) => {
      const ref = cell.getAttribute("r") || "";
      const colMatch = ref.match(/[A-Z]+/i);
      const index = colMatch ? columnNameToIndex(colMatch[0]) : fallbackIndex;
      values[index] = xlsxCellValue(cell, sharedStrings).trim();
    });
    return values.map((value) => value || "");
  }).filter((row) => row.some(Boolean));
}

async function parseXlsxBatchRows(file) {
  const entries = readZipDirectory(await file.arrayBuffer());
  const sharedStrings = parseSharedStrings(await zipEntryText(entries, "xl/sharedStrings.xml"));
  const worksheetPath = await xlsxWorksheetPath(entries);
  return parseWorksheetRows(await zipEntryText(entries, worksheetPath), sharedStrings);
}

async function parseBatchRecordsFromFile(file) {
  const isXlsx = /\.xlsx$/i.test(file.name) || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (isXlsx) return rowsToBatchRecords(await parseXlsxBatchRows(file));
  return parseRoomBatchRows(await file.text());
}

function normalizeDateValue(value) {
  const text = String(value || "").trim().replaceAll("/", "-").replaceAll(".", "-");
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 80000) {
      const date = new Date(Math.round((serial - 25569) * 86400000));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    }
  }
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function recordValue(record, keys) {
  return keys.map((key) => record[key]).find((value) => String(value || "").trim()) || "";
}

function splitBatchList(value) {
  return String(value || "")
    .split(/[；;、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeIdentityValue(value, fallback = "其他") {
  const text = String(value || "").trim();
  return identityOptions.includes(text) ? text : fallback;
}

function normalizeGenderValue(value) {
  const text = String(value || "").trim();
  return ["男", "女"].includes(text) ? text : "";
}

function normalizeNeedRoomType(value) {
  const type = normalizedRoomType(value);
  return type === "未填" ? "其他" : type;
}

function normalizeArrangementHotel(value) {
  const hotel = String(value || "").trim();
  return hotel === "未安排" ? "" : hotel;
}

function personFromBatchRecord(record, fallbackIdentity = "其他") {
  return {
    name: recordValue(record, ["姓名", "姓名/团队名称"]).trim(),
    gender: normalizeGenderValue(record["性别"]),
    phone: recordValue(record, ["电话", "联系方式"]),
    idNo: record["身份证号"] || "",
    identity: normalizeIdentityValue(recordValue(record, ["人员性质", "身份类型"]), fallbackIdentity)
  };
}

function companionsFromBatchRecord(record, mainIdentity) {
  const names = splitBatchList(record["增加人员姓名"]);
  const genders = splitBatchList(record["增加人员性别"]);
  const phones = splitBatchList(record["增加人员电话"]);
  const idNos = splitBatchList(record["增加人员身份证号"]);
  const identities = splitBatchList(record["增加人员性质"]);
  const count = Math.max(names.length, genders.length, phones.length, idNos.length, identities.length);
  return Array.from({ length: count }, (_, index) => ({
    name: names[index] || "",
    gender: normalizeGenderValue(genders[index]),
    phone: phones[index] || "",
    idNo: idNos[index] || "",
    identity: normalizeIdentityValue(identities[index], mainIdentity)
  })).filter((person) => person.name || person.phone || person.idNo);
}

function batchNeedCommonFields(record) {
  return {
    hotel: normalizeArrangementHotel(recordValue(record, ["安排酒店", "酒店"])),
    roomType: normalizeNeedRoomType(recordValue(record, ["房间类型", "期望房型"])),
    roomNo: record["房间号"] || "",
    checkIn: normalizeDateValue(record["入住日期"]),
    checkOut: normalizeDateValue(record["离店日期"])
  };
}

function assertGroupedNeedConsistency(records, sequence) {
  const first = batchNeedCommonFields(records[0]);
  const fieldLabels = {
    hotel: "安排酒店",
    roomType: "房间类型",
    roomNo: "房间号",
    checkIn: "入住日期",
    checkOut: "离店日期"
  };
  records.slice(1).forEach((record) => {
    const current = batchNeedCommonFields(record);
    Object.keys(fieldLabels).forEach((key) => {
      if (current[key] !== first[key]) {
        throw new Error(`序号 ${sequence} 的${fieldLabels[key]}不一致，请统一后再上传`);
      }
    });
  });
  return first;
}

function remarksFromBatchRecords(records) {
  return Array.from(new Set(records.map((record) => String(record["备注"] || "").trim()).filter(Boolean))).join("；");
}

function needFromGroupedBatchRecords(records, sequence) {
  const common = assertGroupedNeedConsistency(records, sequence);
  validateOptionalStayDates(common.checkIn, common.checkOut, `序号 ${sequence}`);
  const people = records.map((record) => personFromBatchRecord(record)).filter((person) => person.name || person.phone || person.idNo);
  if (!people.length || !people[0].name) {
    throw new Error(`序号 ${sequence} 缺少姓名`);
  }
  const [mainPerson, ...companions] = people;
  return {
    name: mainPerson.name,
    identity: mainPerson.identity,
    gender: mainPerson.gender,
    phone: mainPerson.phone,
    idNo: mainPerson.idNo,
    companions,
    people: people.length,
    checkIn: common.checkIn,
    checkOut: common.checkOut,
    hotel: common.hotel,
    roomType: common.roomType,
    roomNo: common.roomNo,
    owner: "",
    note: remarksFromBatchRecords(records),
    adults: people.length,
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

function needsFromBatchRecords(records) {
  const hasSequenceHeader = records.some((record) => Object.prototype.hasOwnProperty.call(record, "序号"));
  if (!hasSequenceHeader) {
    return records.map((record, index) => needFromBatchRecord(record, index));
  }
  const groups = new Map();
  records.forEach((record, index) => {
    const sequence = String(record["序号"] || "").trim();
    if (!sequence) throw new Error(`第 ${index + 2} 行缺少序号`);
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence).push(record);
  });
  return Array.from(groups.entries()).map(([sequence, groupedRecords]) => needFromGroupedBatchRecords(groupedRecords, sequence));
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
  const name = recordValue(record, ["姓名", "姓名/团队名称"]).trim();
  const checkIn = normalizeDateValue(record["入住日期"]);
  const checkOut = normalizeDateValue(record["离店日期"]);
  if (!name) {
    throw new Error(`第 ${index + 2} 行缺少姓名`);
  }
  validateOptionalStayDates(checkIn, checkOut, `第 ${index + 2} 行`);
  const identity = normalizeIdentityValue(recordValue(record, ["人员性质", "身份类型"]));
  const companions = companionsFromBatchRecord(record, identity);
  const hotel = normalizeArrangementHotel(recordValue(record, ["安排酒店", "酒店"]));
  const roomType = normalizeNeedRoomType(recordValue(record, ["房间类型", "期望房型"]));
  const people = Math.max(1, Number(record["人数"]) || 1 + companions.length);
  return {
    name,
    identity,
    gender: normalizeGenderValue(record["性别"]),
    phone: recordValue(record, ["电话", "联系方式"]),
    idNo: record["身份证号"] || "",
    companions,
    people,
    checkIn,
    checkOut,
    hotel,
    roomType,
    roomNo: record["房间号"] || "",
    owner: record["负责人"] || "",
    note: record["备注"] || "",
    adults: people,
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
  const records = await parseBatchRecordsFromFile(file);
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
  if (uploadInProgress) {
    alert("当前已有上传任务正在进行，请等待完成后再上传。");
    return;
  }
  const records = await parseBatchRecordsFromFile(file);
  if (!records.length) {
    alert("没有识别到可导入的入住需求，请使用下载模板填写后再上传。");
    return;
  }
  const needs = [];
  try {
    needs.push(...needsFromBatchRecords(records));
  } catch (error) {
    alert(error.message);
    return;
  }
  const task = createNeedUploadTask(needs);
  savePendingUploadTask(task);
  await runNeedUploadTask(task);
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
    calendar: "酒店统计",
    roleStats: "角色统计",
    roomBalance: "房间余量",
    needs: "入住需求",
    onsite: "现场核对",
    changes: "变更记录"
  };
  $("#viewTitle").textContent = titles[view];
  const exportButton = $("#exportOverviewWorkbookBtn");
  if (exportButton) exportButton.hidden = view !== "dashboard";
  render();
}

function kpiData() {
  const needs = visibleNeeds();
  const totalNeeds = needs.length;
  const nights = needs.reduce((sum, need) => sum + needNightCount(need), 0);
  const people = needs.reduce((sum, need) => sum + peopleForNeed(need).length, 0);
  const withHotel = needs.filter((need) => need.hotel).length;
  const missingHotel = needs.filter((need) => !need.hotel).length;
  const missingRoomNo = needs.filter((need) => !need.roomNo).length;
  return [
    ["总住宿需求", totalNeeds, "一条需求可包含多人"],
    ["总人数", people, "主人员和增加人员合计"],
    ["总房晚", nights, "按入住到离店计算"],
    ["已填酒店", withHotel, "已指定安排酒店"],
    ["待补酒店", missingHotel, "需要补安排酒店"],
    ["待补房间号", missingRoomNo, "需要补房间号"]
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
  if (!visibleNeeds().length) {
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
  const taskGroups = {
    hotel: new Set(),
    date: new Set(),
    info: new Set(),
    roomNo: new Set()
  };
  const addNeedNames = (group, need) => {
    peopleForNeed(need).forEach((person) => group.add(person.name || "未填写姓名"));
  };
  currentFilteredNeeds().forEach((need) => {
    if (!need.hotel) addNeedNames(taskGroups.hotel, need);
    if (!need.checkIn || !need.checkOut) addNeedNames(taskGroups.date, need);
    if (!need.roomNo) addNeedNames(taskGroups.roomNo, need);
    peopleForNeed(need).forEach((person, index) => {
      const identity = index === 0 ? need.identity : person.identity;
      if (!person.phone || !person.idNo || !person.gender || !identity) {
        taskGroups.info.add(person.name || "未填写姓名");
      }
    });
  });
  const tasks = [
    ["待补充酒店", taskGroups.hotel, "status-red"],
    ["待补充日期", taskGroups.date, "status-red"],
    ["待补充信息", taskGroups.info, "status-red"],
    ["待补充房间号", taskGroups.roomNo, "status-yellow"]
  ].filter(([, names]) => names.size);
  $("#taskList").innerHTML = tasks.length ? tasks.map(([type, names, cls]) => `
    <div class="task ${cls}">
      <strong>${type}：${Array.from(names).join("、")}</strong>
      <span>共 ${names.size} 人需要处理</span>
    </div>
  `).join("") : `<div class="task status-green"><strong>暂无待补信息</strong><span>当前入住需求的酒店、日期、基础信息和房间号都已填写。</span></div>`;
}

function renderUseBars() {
  const counts = {};
  visibleNeeds().forEach((need) => {
    peopleForNeed(need).forEach((person) => {
      const identity = personIdentity(person, need.identity);
      counts[identity] = (counts[identity] || 0) + 1;
    });
  });
  if (!Object.keys(counts).length) {
    $("#useBars").innerHTML = `<div class="task"><strong>暂无人员数据</strong><span>新增入住需求后，这里会显示人员性质分布。</span></div>`;
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

function renderHotelBars() {
  const counts = {};
  visibleNeeds().forEach((need) => {
    const hotel = normalizedNeedHotel(need.hotel) || "未安排酒店";
    counts[hotel] = (counts[hotel] || 0) + 1;
  });
  if (!Object.keys(counts).length) {
    $("#hotelBars").innerHTML = `<div class="task"><strong>暂无酒店数据</strong><span>新增入住需求后，这里会显示酒店分布。</span></div>`;
    return;
  }
  const max = Math.max(1, ...Object.values(counts));
  $("#hotelBars").innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([hotel, count]) => `
    <div class="bar-row">
      <span>${hotel}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(count / max * 100)}%"></div></div>
      <strong>${count}</strong>
    </div>
  `).join("");
}

function optionHtml(value, label = value) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function setSelectOptions(selector, optionsHtml, fallback = "all") {
  const select = $(selector);
  if (!select) return;
  const previous = select.value || fallback;
  select.innerHTML = optionsHtml;
  const hasPrevious = Array.from(select.options).some((option) => option.value === previous);
  select.value = hasPrevious ? previous : fallback;
}

function populateFilters() {
  const hotelOptions = [optionHtml("all", "全部酒店"), ...needHotels().map((hotel) => optionHtml(hotel))].join("");
  const balanceHotelOptions = [optionHtml("all", "全部酒店"), ...roomCapacityHotels().map((hotel) => optionHtml(hotel))].join("");
  const roleOptions = [optionHtml("all", "全部人员性质"), ...roleIdentities().map((identity) => optionHtml(identity))].join("");
  const dateOptions = activeDates().map((date) => `<option value="${date}">${date}</option>`).join("");
  setSelectOptions("#calendarIdentity", roleOptions);
  setSelectOptions("#roleHotel", hotelOptions);
  setSelectOptions("#balanceHotel", balanceHotelOptions);
  setSelectOptions("#onsiteHotel", hotelOptions);
  setSelectOptions("#needHotelFilter", hotelOptions);
  setSelectOptions("#needIdentityFilter", roleOptions);
  if ($("#onsiteDate")) $("#onsiteDate").innerHTML = dateOptions;
  const dates = activeDates();
  if (!$("#calendarStartInput").value) $("#calendarStartInput").value = defaultHotelInfoRange.start;
  if (!$("#calendarEndInput").value) $("#calendarEndInput").value = defaultHotelInfoRange.end;
  refreshCalendarDateRange();
  if (!$("#roleStartInput").value) $("#roleStartInput").value = defaultHotelInfoRange.start;
  if (!$("#roleEndInput").value) $("#roleEndInput").value = defaultHotelInfoRange.end;
  refreshDateRangePicker(document.querySelector("[data-role-range]"));
  if ($("#balanceStartInput") && !$("#balanceStartInput").value) $("#balanceStartInput").value = defaultHotelInfoRange.start;
  if ($("#balanceEndInput") && !$("#balanceEndInput").value) $("#balanceEndInput").value = defaultHotelInfoRange.end;
  refreshDateRangePicker(document.querySelector("[data-balance-range]"));
  if ($("#onsiteDate") && !$("#onsiteDate").value) $("#onsiteDate").value = activeDates()[0];
}

function renderCalendar() {
  const selectedIdentity = $("#calendarIdentity").value || "all";
  const checkIn = $("#calendarStartInput").value || activeDates()[0] || defaultDate();
  const checkOut = $("#calendarEndInput").value || checkIn;
  const dates = checkIn <= checkOut ? nightsBetween(checkIn, addDays(checkOut, 1)) : [];
  const hotels = needHotels();
  if (!dates.length) {
    $("#roomBoard").innerHTML = `<div class="board-cell header">请选择开始日期和结束日期。</div>`;
    return;
  }
  if (!hotels.length || !visibleNeeds().length) {
    $("#roomBoard").innerHTML = `<div class="board-cell header">当前筛选条件下暂无入住需求。</div>`;
    return;
  }
  const header = [`<div class="board-cell header">酒店</div>`, ...dates.map((date) => `<div class="board-cell header">${date}</div>`)];
  const rows = hotels.flatMap((hotel) => [
    `<div class="board-cell room-name">${hotel}<small>按入住需求统计</small></div>`,
    ...dates.map((date) => {
      const needs = needStaysOnDate(date, hotel, selectedIdentity);
      return `
        <div class="board-cell hotel-info-cell">
          <div class="room-type-counts">${roomTypeCountLines(needs)}</div>
        </div>
      `;
    })
  ]);
  $("#roomBoard").innerHTML = `<div class="board-grid" style="grid-template-columns: 136px repeat(${dates.length}, minmax(124px, 1fr))">${[...header, ...rows].join("")}</div>`;
}

function renderRoleStats() {
  const selectedHotel = $("#roleHotel").value || "all";
  const checkIn = $("#roleStartInput").value || defaultHotelInfoRange.start;
  const checkOut = $("#roleEndInput").value || defaultHotelInfoRange.end;
  const dates = checkIn <= checkOut ? nightsBetween(checkIn, addDays(checkOut, 1)) : [];
  const identities = roleIdentities();
  if (!dates.length) {
    $("#roleStatsBoard").innerHTML = `<div class="board-cell header">请选择开始日期和结束日期。</div>`;
    return;
  }
  if (!identities.length || !visibleNeeds().length) {
    $("#roleStatsBoard").innerHTML = `<div class="board-cell header">当前筛选条件下暂无入住需求。</div>`;
    return;
  }
  const header = [`<div class="board-cell header">人员性质</div>`, ...dates.map((date) => `<div class="board-cell header">${date}</div>`)];
  const rows = identities.flatMap((identity) => [
    `<div class="board-cell room-name">${identity}<small>按人员性质统计</small></div>`,
    ...dates.map((date) => {
      const needs = roleNeedsOnDate(date, identity, selectedHotel);
      return `
        <div class="board-cell hotel-info-cell">
          <div class="room-type-counts">${roomTypeCountLines(needs)}</div>
        </div>
      `;
    })
  ]);
  $("#roleStatsBoard").innerHTML = `<div class="board-grid" style="grid-template-columns: 136px repeat(${dates.length}, minmax(124px, 1fr))">${[...header, ...rows].join("")}</div>`;
}

function renderRoomBalance() {
  const selectedHotel = $("#balanceHotel").value || "all";
  const checkIn = $("#balanceStartInput").value || defaultHotelInfoRange.start;
  const checkOut = $("#balanceEndInput").value || defaultHotelInfoRange.end;
  const dates = checkIn <= checkOut ? nightsBetween(checkIn, addDays(checkOut, 1)) : [];
  const hotels = roomCapacityHotels().filter((hotel) => selectedHotel === "all" || hotel === selectedHotel);
  if (!dates.length) {
    $("#roomBalanceBoard").innerHTML = `<div class="board-cell header">请选择开始日期和结束日期。</div>`;
    return;
  }
  if (!hotels.length) {
    $("#roomBalanceBoard").innerHTML = `<div class="board-cell header">当前筛选条件下暂无酒店总量。</div>`;
    return;
  }
  const header = [`<div class="board-cell header">酒店</div>`, ...dates.map((date) => `<div class="board-cell header">${date}</div>`)];
  const rows = hotels.flatMap((hotel) => [
    `<div class="board-cell room-name">${hotel}<small>剩余 / 总共</small></div>`,
    ...dates.map((date) => `
      <div class="board-cell hotel-info-cell">
        <div class="room-type-counts">${roomBalanceCountLines(date, hotel)}</div>
      </div>
    `)
  ]);
  $("#roomBalanceBoard").innerHTML = `<div class="board-grid" style="grid-template-columns: 136px repeat(${dates.length}, minmax(124px, 1fr))">${[...header, ...rows].join("")}</div>`;
}

function populateAssignmentForm() {
  const pendingNeedRanges = visibleNeeds()
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
  const rows = currentFilteredNeeds()
    .map((need, index) => ({
      ...need,
      sequence: index + 1,
      nameList: peopleFieldCell(need, "name"),
      genderList: peopleFieldCell(need, "gender"),
      phoneList: peopleFieldCell(need, "phone"),
      idNoList: peopleFieldCell(need, "idNo"),
      identityList: peopleFieldCell(need, "identity"),
      stayTime: stayTimeCell(need),
      stayDays: `${needNightCount(need)}天`
    }));
  const peopleCount = rows.reduce((sum, need) => sum + peopleForNeed(need).length, 0);
  const nightCount = rows.reduce((sum, need) => sum + needNightCount(need), 0);
  $("#needsSummary").textContent = `共 ${rows.length} 条需求，${peopleCount} 人，${nightCount} 间夜`;
  $("#needsTable").innerHTML = table([
    { key: "sequence", label: "序号" },
    { key: "nameList", label: "姓名", html: true },
    { key: "genderList", label: "性别", html: true },
    { key: "phoneList", label: "电话", html: true },
    { key: "idNoList", label: "身份证号", html: true },
    { key: "identityList", label: "人员性质", html: true },
    { key: "stayTime", label: "入住时间", html: true },
    { key: "stayDays", label: "入住天数" },
    { key: "hotel", label: "安排酒店" },
    { key: "roomNo", label: "房间号" },
    { key: "roomType", label: "房间类型" },
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
    renderHotelBars();
  }
  if (activeView === "calendar") renderCalendar();
  if (activeView === "roleStats") renderRoleStats();
  if (activeView === "roomBalance") renderRoomBalance();
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
                <div class="date-range-footer-actions">
                  ${field.allowEmpty ? `<button class="ghost-btn range-clear-btn" type="button" data-range-clear>清空</button>` : ""}
                  <button class="primary-btn" type="button" data-range-apply>确认</button>
                </div>
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
    adults: people
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
    { key: "companions", type: "peopleRepeater" },
    { key: "hotel", label: "安排酒店", type: "select", options: ["", ...arrangementHotelOptions] },
    { key: "roomNo", label: "房间号" },
    { key: "roomType", label: "房间类型", type: "select", options: roomTypeOptions },
    { label: "日期", type: "dateRange", startKey: "checkIn", endKey: "checkOut", allowEmpty: true },
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
  $("#exportOverviewWorkbookBtn")?.addEventListener("click", exportOverviewWorkbook);
  $("#needHotelFilter")?.addEventListener("change", renderNeeds);
  $("#needIdentityFilter")?.addEventListener("change", renderNeeds);
  $("#calendarIdentity").addEventListener("change", renderCalendar);
  $("#exportHotelStatsBtn")?.addEventListener("click", exportHotelStats);
  $("#roleHotel").addEventListener("change", renderRoleStats);
  $("#exportRoleStatsBtn")?.addEventListener("click", exportRoleStats);
  $("#balanceHotel")?.addEventListener("change", renderRoomBalance);
  $("#exportRoomBalanceBtn")?.addEventListener("click", exportRoomBalance);
  $("#onsiteDate")?.addEventListener("change", renderOnsite);
  $("#onsiteHotel")?.addEventListener("change", renderOnsite);

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
      identity: "工作人员",
      roomType: "双标"
    }, (values) => {
      validateOptionalStayDates(values.checkIn, values.checkOut, "入住需求");
      const need = { id: nextId("REQ-", state.needs), children: 0, sameRoom: "是", share: "否", quiet: "否", smokeFree: "否", lowFloor: "否", nearElevator: "否", confirmed: "否", ...normalizeNeedValues(values) };
      state.needs.push(need);
      addDatesToEventRange(nightsBetween(need.checkIn, need.checkOut));
      return {
        type: "need",
        need,
        operationType: "新增需求",
        operationDescription: `网站新增入住需求：${need.name || need.id}`
      };
    });
  });
  $("#downloadNeedTemplateBtn").addEventListener("click", downloadNeedTemplate);
  $("#exportCurrentNeedsBtn").addEventListener("click", exportCurrentNeeds);
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

  $("#addChangeBtn")?.addEventListener("click", () => {
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
    const rangeClear = event.target.closest("[data-range-clear]");
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
      if (picker.matches("[data-role-range]")) renderRoleStats();
      if (picker.matches("[data-balance-range]")) renderRoomBalance();
      return;
    }
    if (rangeClear) {
      event.preventDefault();
      const picker = rangeClear.closest("[data-date-range]");
      picker.querySelector("[data-range-start]").value = "";
      picker.querySelector("[data-range-end]").value = "";
      renderRangeCalendar(picker);
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
      if (!confirm(`确定删除 ${need.name || "这条入住需求"} 吗？`)) return;
      state.needs = state.needs.filter((item) => item.id !== need.id);
      deleteNeedState(need.id, {
        operationType: "删除需求",
        operationDescription: `网站删除入住需求：${need.name || need.id}`,
        batchId: need.uploadBatchId || ""
      });
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
      openDialog("编辑入住需求", needFields(), need, (values) => {
        validateOptionalStayDates(values.checkIn, values.checkOut, "入住需求");
        Object.assign(need, normalizeNeedValues(values));
        addDatesToEventRange(nightsBetween(need.checkIn, need.checkOut));
        return {
          type: "need",
          need,
          operationType: "编辑需求",
          operationDescription: `网站编辑入住需求：${need.name || need.id}`
        };
      });
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
    let result;
    try {
      result = editing.onSave(dialogValues());
    } catch (error) {
      alert(error.message);
      return;
    }
    if (result?.type === "need") {
      saveNeedState(result.need, {
        operationType: result.operationType,
        operationDescription: result.operationDescription
      });
    } else {
      saveState();
    }
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
  await resumePendingUploadIfNeeded();
}

initializeApp();
