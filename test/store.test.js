const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../store.js");

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => map
  };
}

function seg(id, partial) {
  return { id, code: id, duration: 10, shift: "正常", damage: "完好", note: "", thumb: "", ...partial };
}
function project(library, reels) {
  return {
    schemaVersion: 2,
    library,
    reels:
      reels || [
        {
          id: "r1",
          title: "卷一",
          status: "draft",
          finalizedAt: null,
          slots: library.map((s, i) => ({ id: `sl${i}`, segmentId: s.id, substituteId: null, substituteCancelled: false })),
          runOrder: []
        }
      ],
    activeReelId: "r1"
  };
}

test("首次启动播种；commit 后 revision 前进且可撤销/重做", () => {
  const store = createStore({ storage: memStorage() });
  const rev0 = store.getRevision();
  const next = JSON.parse(JSON.stringify(store.getState()));
  next.library[0].note = "改过";
  const r = store.commit(next);
  assert.equal(r.status, "applied");
  assert.ok(store.getRevision() > rev0);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.notEqual(store.getState().library[0].note, "改过");
  assert.equal(store.canRedo(), true);
  store.redo();
  assert.equal(store.getState().library[0].note, "改过");
});

test("两个页面分叉改不同字段 -> 提交时自动三路合并", () => {
  const storage = memStorage();
  const pageA = createStore({ storage });
  // 模拟页面 B 在另一个 store 实例打开（同 revision/base）
  const pageB = createStore({ storage });

  const aNext = JSON.parse(JSON.stringify(pageA.getState()));
  aNext.library[0].note = "A 改备注";
  assert.equal(pageA.commit(aNext).status, "applied");

  const bNext = JSON.parse(JSON.stringify(pageB.getState()));
  bNext.library[0].duration = bNext.library[0].duration + 7;
  const result = pageB.commit(bNext);
  assert.equal(result.status, "applied");
  assert.equal(result.autoMerged, true);
  const merged = pageB.getState().library[0];
  assert.equal(merged.note, "A 改备注");
  assert.equal(merged.duration, pageA.getState().library[0].duration + 7 - 0 + 0); // B 的时长修改保留
  // A 刷新视角：storage 里已包含双方修改
  const aView = JSON.parse(storage.getItem("zfl17-film-rehearsal-stage"));
  assert.equal(aView.state.library[0].note, "A 改备注");
  assert.equal(aView.state.library[0].duration, bNext.library[0].duration);
});

test("两个页面分叉改同一字段 -> conflict，人工裁决后才能落盘", () => {
  const storage = memStorage();
  const pageA = createStore({ storage });
  const pageB = createStore({ storage });
  const aNext = JSON.parse(JSON.stringify(pageA.getState()));
  aNext.library[0].duration = 111;
  pageA.commit(aNext);

  const bNext = JSON.parse(JSON.stringify(pageB.getState()));
  bNext.library[0].duration = 222;
  const pending = pageB.commit(bNext);
  assert.equal(pending.status, "conflict");
  assert.equal(pending.result.unresolvedCount >= 1, true);

  // 错误裁决值不被接受
  const key = pending.result.conflicts[0].key;
  const resolved = pageB.resolveCommit(pending, { [key]: "right" });
  assert.equal(resolved.status, "applied");
  assert.equal(pageB.getState().library[0].duration, 222);
});

test("storage 事件：另一页面干净写入，本页无本地修改时直接同步", () => {
  const storage = memStorage();
  const pageA = createStore({ storage });
  const pageB = createStore({ storage });
  let events = [];
  pageB.subscribe((e) => events.push(e.type));
  const aNext = JSON.parse(JSON.stringify(pageA.getState()));
  aNext.library[0].note = "远端更新";
  pageA.commit(aNext);
  const raw = JSON.parse(storage.getItem("zfl17-film-rehearsal-stage"));
  pageB.handleIncomingEntry(raw);
  assert.equal(pageB.getState().library[0].note, "远端更新");
  assert.ok(events.includes("remote-applied"));
});

test("异常导入：坏 JSON / 结构错误逐条报错，现有数据不动", () => {
  const store = createStore({ storage: memStorage() });
  const before = JSON.stringify(store.getState());
  const badJson = store.importProject("{not json");
  assert.equal(badJson.status, "invalid");

  const badShape = store.importProject(
    JSON.stringify({
      library: [{ id: "x", duration: -1 }],
      reels: [{ id: "r", slots: [{ id: "s", segmentId: "ghost" }] }]
    })
  );
  assert.equal(badShape.status, "invalid");
  assert.ok(badShape.errors.length >= 2);
  assert.equal(JSON.stringify(store.getState()), before);
});

test("正常导入整体替换且可撤销", () => {
  const store = createStore({ storage: memStorage() });
  const result = store.importProject(JSON.stringify(project([seg("n1", { duration: 40 })])));
  assert.equal(result.status, "applied");
  assert.equal(store.getState().library.length, 1);
  assert.equal(store.getState().library[0].id, "n1");
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.notEqual(store.getState().library.length, 1);
});

test("暂停同步（分叉排练）：本地修改不写盘，恢复时 flush 落盘", () => {
  const storage = memStorage();
  const store = createStore({ storage });
  const baseRev = store.getRevision();
  store.setPaused(true);
  const local = JSON.parse(JSON.stringify(store.getState()));
  local.library[0].note = "暂停期间的本地修改";
  assert.equal(store.commit(local).status, "local");
  // 暂停期间 storage 不动
  const stored = JSON.parse(storage.getItem("zfl17-film-rehearsal-stage"));
  assert.equal(stored.revision, baseRev);
  assert.notEqual(stored.state.library[0].note, "暂停期间的本地修改");

  const resumed = store.setPaused(false);
  assert.equal(resumed.status, "applied");
  const after = JSON.parse(storage.getItem("zfl17-film-rehearsal-stage"));
  assert.equal(after.state.library[0].note, "暂停期间的本地修改");
  assert.ok(after.revision > baseRev);
});

test("分叉排练期间对方也改同字段：恢复时冲突，裁决后合并", () => {
  const storage = memStorage();
  const a = createStore({ storage });
  const b = createStore({ storage });
  a.setPaused(true);
  b.setPaused(true);
  const aState = JSON.parse(JSON.stringify(a.getState()));
  aState.library[0].duration = 301;
  a.commit(aState);
  const bState = JSON.parse(JSON.stringify(b.getState()));
  bState.library[0].duration = 302;
  b.commit(bState);

  const aResume = a.setPaused(false);
  assert.equal(aResume.status, "applied");
  const bResume = b.setPaused(false);
  assert.equal(bResume.status, "conflict");
  const key = bResume.result.conflicts[0].key;
  const resolved = storeResolve(b, bResume, { [key]: "left" });
  assert.equal(resolved.status, "applied");
  assert.equal(b.getState().library[0].duration, 301);
});

function storeResolve(store, pending, resolutions) {
  return store.resolveCommit(pending, resolutions);
}

test("旧版数据自动迁移", () => {  const storage = memStorage();
  storage.setItem(
    "zfl17-film-strip-desk",
    JSON.stringify({ reelTitle: "旧卷", segments: [{ id: "z1", code: "Z-1", duration: 8, shift: "正常", damage: "完好", note: "", thumb: "" }] })
  );
  const store = createStore({ storage });
  assert.equal(store.boot.migrated, true);
  assert.equal(store.getState().library[0].code, "Z-1");
  assert.equal(store.getState().reels.length, 1);
});
