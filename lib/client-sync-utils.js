(function exposeClientSyncUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClientSyncUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createClientSyncUtils() {
  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function equal(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function changedKeys(base, value) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(value || {})]);
    keys.delete("id");
    return Array.from(keys).filter((key) => !equal(base?.[key], value?.[key]));
  }

  function analyzeNeedMerge(baseNeed, localNeed, remoteNeed) {
    if (!baseNeed) {
      return {
        merged: clone(localNeed),
        conflicts: remoteNeed && !equal(remoteNeed, localNeed) ? ["整条需求"] : [],
        changed: changedKeys({}, localNeed)
      };
    }
    const localChanged = changedKeys(baseNeed, localNeed);
    const remoteChanged = changedKeys(baseNeed, remoteNeed || {});
    const remoteChangedSet = new Set(remoteChanged);
    const merged = clone(remoteNeed || baseNeed);
    localChanged.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(localNeed || {}, key)) merged[key] = clone(localNeed[key]);
      else delete merged[key];
    });
    merged.id = localNeed.id;
    return {
      merged,
      changed: localChanged,
      conflicts: localChanged.filter((key) => remoteChangedSet.has(key))
    };
  }

  function applyOperationToState(targetState, payload) {
    const next = clone(targetState || {});
    next.needs = Array.isArray(next.needs) ? next.needs : [];
    const upsert = (need) => {
      const index = next.needs.findIndex((item) => item.id === need.id);
      if (index >= 0) next.needs[index] = clone(need);
      else next.needs.push(clone(need));
    };
    if (payload?.action === "upsertNeed" && payload.need) upsert(payload.need);
    if (payload?.action === "upsertNeeds") (payload.needs || []).forEach(upsert);
    if (payload?.action === "deleteNeed") next.needs = next.needs.filter((need) => need.id !== payload.needId);
    if (payload?.action === "deleteNeeds") {
      const deleting = new Set(payload.needIds || []);
      next.needs = next.needs.filter((need) => !deleting.has(need.id));
    }
    if (payload?.state?.needs) next.needs = clone(payload.state.needs);
    return next;
  }

  return { analyzeNeedMerge, applyOperationToState, changedKeys };
});
