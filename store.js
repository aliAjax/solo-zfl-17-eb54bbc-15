/*
 * 存储层：revision 版本号 + 共同祖先快照 + 撤销重做 + 多页面分叉检测
 * 写入流程：
 *   commit(nextState) 时若 storage 里的 revision 高于本页面基线 -> 与基线做三路合并
 *     · 干净合并：自动采用，本次提交照常落盘，revision +1
 *     · 有冲突：返回 {status:'conflict'}，由 UI 收集人工裁决后调用 resolveCommit
 * 同一浏览器其他页面写入时，通过 storage 事件做同样的合并（未提交的本地修改视为分叉）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./model.js"), require("./merge.js"));
  } else {
    root.FilmStore = factory(root.FilmModel, root.FilmMerge);
  }
})(typeof self !== "undefined" ? self : this, function (Model, Merge) {
  "use strict";

  function shallowTrackedClone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function createStore(options) {
    const opts = options || {};
    const storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const listeners = [];
    let record = null; // { state, revision, baseState, baseRevision }
    let undoStack = [];
    let redoStack = [];
    let suppressedStorageAt = 0;
    let pendingIncoming = null; // 恢复同步时待处理的远端条目
    let paused = false; // 分叉排练：本地修改只留在内存，不写 storage
    let remoteWhilePaused = null;

    function isPaused() {
      return paused;
    }

    function setPaused(value) {
      paused = !!value;
      if (!paused) {
        // 恢复时无论远端是否前进，都要把暂停期间的本地修改 flush / 合并
        const remote = remoteWhilePaused;
        remoteWhilePaused = null;
        return resumeMerge(remote);
      }
      return { status: "paused", paused };
    }

    function readRaw() {
      if (!storage) return null;
      const raw = storage.getItem(Model.STORAGE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.state) return null;
        return parsed;
      } catch {
        return null;
      }
    }

    function writeRaw(entry) {
      if (!storage) return;
      suppressedStorageAt = Date.now();
      storage.setItem(Model.STORAGE_KEY, JSON.stringify(entry));
    }

    function bootstrap() {
      let entry = readRaw();
      let migrated = false;
      if (!entry && storage) {
        const legacy = storage.getItem(Model.LEGACY_STORAGE_KEY);
        if (legacy) {
          const state = Model.migrateLegacy(legacy);
          if (state) {
            entry = { state, revision: 1, baseState: shallowTrackedClone(state), baseRevision: 1 };
            writeRaw(entry);
            migrated = true;
          }
        }
      }
      if (!entry) {
        const state = Model.seedState();
        entry = { state, revision: 1, baseState: shallowTrackedClone(state), baseRevision: 1 };
        writeRaw(entry);
      }
      // 结构兜底
      entry.state = ensureStructure(entry.state);
      entry.baseState = entry.baseState ? ensureStructure(entry.baseState) : shallowTrackedClone(entry.state);
      entry.revision = Number(entry.revision) || 1;
      entry.baseRevision = Number(entry.baseRevision) || entry.revision;
      record = entry;
      undoStack = [];
      redoStack = [];
      return { migrated };
    }

    function ensureStructure(state) {
      if (!state || typeof state !== "object") return Model.seedState();
      return {
        schemaVersion: Model.SCHEMA_VERSION,
        library: Array.isArray(state.library) ? state.library : [],
        reels: Array.isArray(state.reels) ? state.reels : [],
        activeReelId: state.activeReelId || null
      };
    }

    function getState() {
      return record.state;
    }

    function getRevision() {
      return record.revision;
    }

    function getBase() {
      return { state: record.baseState, revision: record.baseRevision };
    }

    function pushHistory(prevState) {
      undoStack.push({ state: shallowTrackedClone(prevState), revision: record.revision });
      if (undoStack.length > Model.HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }

    function snapshot() {
      return shallowTrackedClone(record.state);
    }

    // 三路合并并落盘；返回 {status:'applied'|'conflict'|'noop', result?}
    function mergeAndWrite(nextState, meta, writeOpts) {
      const remote = readRaw();
      // 远端 revision 高于本页面共同祖先 -> 分叉，需要三路合并
      if (!remote || remote.revision <= record.baseRevision) {
        return finishWrite(nextState, remote ? remote.revision : record.revision, meta, "applied", writeOpts);
      }

      // 远端已前进：本页面加载/上次同步时的快照才是双方共同祖先
      const ancestor = record.baseState;
      const result = Merge.mergeThreeWay(ancestor, remote.state, nextState);
      if (!result.resolved) {
        return {
          status: "conflict",
          remote,
          local: nextState,
          base: ancestor,
          result,
          meta
        };
      }
      const mergedState = ensureStructure(result.state);
      return finishWrite(mergedState, remote.revision, meta, "applied", {
        ...(writeOpts || {}),
        autoMerged: true,
        stats: result.stats
      });
    }

    function finishWrite(nextState, remoteRevision, meta, status, extra) {
      const opts = extra || {};
      const prev = record.state;
      record.baseState = shallowTrackedClone(nextState);
      record.baseRevision = Math.max(record.revision, remoteRevision) + 1;
      record.state = nextState;
      record.revision = record.baseRevision;
      writeRaw({
        state: record.state,
        revision: record.revision,
        baseState: record.baseState,
        baseRevision: record.baseRevision
      });
      if (!opts.skipHistory) pushHistory(prev);
      emit({
        type: "commit",
        status,
        meta: meta || null,
        ...extra
      });
      return { status: "applied", revision: record.revision, ...(extra || {}) };
    }

    // 普通提交：调用方传入"完整新状态"
    function commit(nextState, meta, writeOpts) {
      const normalized = ensureStructure(nextState);
      if (Merge.deepEqual(normalized, record.state)) return { status: "noop" };
      if (paused) {
        // 分叉排练：只更新内存，不写盘；撤销栈照常
        if (!writeOpts || !writeOpts.skipHistory) pushHistory(record.state);
        record.state = normalized;
        emit({ type: "commit", status: "local", meta: meta || null });
        return { status: "local" };
      }
      return mergeAndWrite(normalized, meta, writeOpts);
    }

    // 切换当前卷等纯界面状态：同版本号静默持久化（刷新可恢复），不入撤销栈，不造成分叉
    function setActiveReel(reelId) {
      if (!record.state.reels.some((r) => r.id === reelId)) return { status: "noop" };
      record.state.activeReelId = reelId;
      if (paused) {
        emit({ type: "active-reel" });
        return { status: "local" };
      }
      const snapshot = shallowTrackedClone(record.state);
      record.baseState = snapshot;
      writeRaw({
        state: snapshot,
        revision: record.revision,
        baseState: snapshot,
        baseRevision: record.baseRevision
      });
      emit({ type: "active-reel" });
      return { status: "applied" };
    }

    // 恢复同步：把暂停期间的本地修改与远端分叉合并
    function resumeMerge(remote) {
      const currentRemote = remote || readRaw();
      if (!currentRemote || currentRemote.revision <= record.baseRevision) {
        // 远端没有前进：本地修改直接落盘
        if (!Merge.deepEqual(record.state, record.baseState)) {
          return finishWrite(record.state, currentRemote ? currentRemote.revision : record.baseRevision, { kind: "resume" }, "applied");
        }
        return { status: "applied" };
      }
      const ancestor = record.baseState;
      const result = Merge.mergeThreeWay(ancestor, currentRemote.state, record.state);
      if (!result.resolved) {
        return {
          status: "conflict",
          remote: currentRemote,
          local: record.state,
          base: ancestor,
          result,
          meta: { kind: "resume" }
        };
      }
      return finishWrite(ensureStructure(result.state), currentRemote.revision, { kind: "resume" }, "applied", {
        autoMerged: true,
        stats: result.stats
      });
    }

    // 冲突裁决后再次提交：resolutions 为人工选择
    function resolveCommit(pending, resolutions) {
      const result = Merge.mergeThreeWay(pending.base, pending.remote.state, pending.local, resolutions);
      if (!result.resolved) {
        return { status: "conflict", ...pending, result };
      }
      return finishWrite(ensureStructure(result.state), pending.remote.revision, pending.meta, "applied", {
        autoMerged: false,
        manuallyResolved: true,
        stats: result.stats
      });
    }

    // 放弃自己的分叉，直接采用远端版本
    function adoptRemote(pending) {
      const incoming = ensureStructure(pending.remote.state);
      const prev = record.state;
      record.state = incoming;
      record.baseState = pending.remote.baseState ? ensureStructure(pending.remote.baseState) : shallowTrackedClone(incoming);
      record.baseRevision = pending.remote.revision;
      record.revision = pending.remote.revision;
      undoStack = [];
      redoStack = [];
      emit({ type: "adopt-remote" });
      return { status: "applied" };
    }

    // 撤销/重做也走分叉合并，避免覆盖其他页面的更新
    function undo() {
      if (!undoStack.length) return { status: "noop" };
      const entry = undoStack.pop();
      redoStack.push({ state: shallowTrackedClone(record.state) });
      if (paused) {
        record.state = ensureStructure(entry.state);
        emit({ type: "undo", status: "local" });
        return { status: "local" };
      }
      const result = mergeAndWrite(entry.state, { kind: "undo" }, { skipHistory: true });
      if (result.status !== "applied") {
        // 分叉冲突：回退历史栈动作，把冲突交给 UI
        redoStack.pop();
        undoStack.push(entry);
      }
      return result;
    }

    function redo() {
      if (!redoStack.length) return { status: "noop" };
      const entry = redoStack.pop();
      undoStack.push({ state: shallowTrackedClone(record.state) });
      if (paused) {
        record.state = ensureStructure(entry.state);
        emit({ type: "redo", status: "local" });
        return { status: "local" };
      }
      const result = mergeAndWrite(entry.state, { kind: "redo" }, { skipHistory: true });
      if (result.status !== "applied") {
        undoStack.pop();
        redoStack.push(entry);
      }
      return result;
    }

    function canUndo() {
      return undoStack.length > 0;
    }
    function canRedo() {
      return redoStack.length > 0;
    }

    // 导入：校验通过后整体替换为新工程（revision 前进、可撤销）
    function importProject(json) {
      let parsed;
      try {
        parsed = typeof json === "string" ? JSON.parse(json) : json;
      } catch (error) {
        return { status: "invalid", errors: [{ path: "$", message: `JSON 解析失败：${error.message}` }], warnings: [] };
      }
      const checked = Model.validateProject(parsed);
      if (!checked.ok) {
        return { status: "invalid", errors: checked.errors, warnings: checked.warnings };
      }
      const next = {
        schemaVersion: Model.SCHEMA_VERSION,
        library: checked.state.library,
        reels: checked.state.reels,
        activeReelId: checked.state.activeReelId
      };
      const writeResult = commit(next, { kind: "import" });
      if (writeResult.status === "applied") {
        return { status: "applied", warnings: checked.warnings, stats: writeResult.stats || null, autoMerged: !!writeResult.autoMerged };
      }
      return { status: "conflict", errors: [], warnings: checked.warnings, pending: writeResult };
    }

    function exportProject() {
      return JSON.stringify(Model.toProject(record.state), null, 2);
    }

    function emit(event) {
      listeners.slice().forEach((fn) => {
        try {
          fn(event);
        } catch (error) {
          console.error(error);
        }
      });
    }
    function subscribe(fn) {
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    // 另一个页面写入：把本页面未提交（自 base 起）的修改视作右分叉
    function handleIncomingEntry(remote) {
      if (!remote || !remote.state) return null;
      if (remote.revision <= record.baseRevision) return null;
      if (paused) {
        // 分叉排练期间不打扰本地工作，只缓存最新远端，恢复同步时再合并
        remoteWhilePaused = remote;
        emit({ type: "remote-paused", remote });
        return { status: "paused" };
      }
      const localChanged = !Merge.deepEqual(record.state, record.baseState);
      if (!localChanged) {
        const prev = record.state;
        record.state = ensureStructure(remote.state);
        record.baseState = remote.baseState ? ensureStructure(remote.baseState) : shallowTrackedClone(record.state);
        record.baseRevision = remote.revision;
        record.revision = remote.revision;
        undoStack = [];
        redoStack = [];
        emit({ type: "remote-applied", autoMerged: false });
        return { status: "applied" };
      }
      const ancestor = record.baseState;
      const result = Merge.mergeThreeWay(ancestor, remote.state, record.state);
      if (result.resolved) {
        record.state = ensureStructure(result.state);
        record.baseState = shallowTrackedClone(record.state);
        record.baseRevision = remote.revision + 1;
        record.revision = record.baseRevision;
        writeRaw({
          state: record.state,
          revision: record.revision,
          baseState: record.baseState,
          baseRevision: record.baseRevision
        });
        undoStack = [];
        redoStack = [];
        emit({ type: "remote-applied", autoMerged: true, stats: result.stats });
        return { status: "applied", autoMerged: true };
      }
      pendingIncoming = { remote, result };
      emit({ type: "remote-conflict", remote, result });
      return { status: "conflict", remote, result };
    }

    function resolveIncoming(resolutions) {
      if (!pendingIncoming) return { status: "noop" };
      const { remote } = pendingIncoming;
      const ancestor = record.baseState;
      const result = Merge.mergeThreeWay(ancestor, remote.state, record.state, resolutions);
      pendingIncoming = null;
      if (!result.resolved) return { status: "conflict", result };
      record.state = ensureStructure(result.state);
      record.baseState = shallowTrackedClone(record.state);
      record.baseRevision = remote.revision + 1;
      record.revision = record.baseRevision;
      writeRaw({
        state: record.state,
        revision: record.revision,
        baseState: record.baseState,
        baseRevision: record.baseRevision
      });
      undoStack = [];
      redoStack = [];
      emit({ type: "remote-applied", manuallyResolved: true, stats: result.stats });
      return { status: "applied", stats: result.stats };
    }

    function discardIncoming() {
      pendingIncoming = null;
    }

    if (typeof window !== "undefined" && storage && typeof window.addEventListener === "function") {
      window.addEventListener("storage", (event) => {
        if (event.key !== Model.STORAGE_KEY) return;
        if (Date.now() - suppressedStorageAt < 500) return;
        if (!event.newValue) return;
        let remote;
        try {
          remote = JSON.parse(event.newValue);
        } catch {
          return;
        }
        handleIncomingEntry(remote);
      });
    }

    const boot = bootstrap();

    return {
      boot,
      getState,
      getRevision,
      getBase,
      snapshot,
      commit,
      resolveCommit,
      adoptRemote,
      undo,
      redo,
      canUndo,
      canRedo,
      importProject,
      exportProject,
      subscribe,
      handleIncomingEntry,
      resolveIncoming,
      discardIncoming,
      isPaused,
      setPaused,
      setActiveReel,
      // 测试用
      _peek: () => ({ record, undoStackLength: undoStack.length, redoStackLength: redoStack.length })
    };
  }

  return { createStore };
});
