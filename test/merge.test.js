const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeThreeWay } = require("../merge.js");

function state(partial) {
  return {
    schemaVersion: 2,
    library: [],
    reels: [],
    activeReelId: null,
    ...partial
  };
}
function seg(id, partial) {
  return { id, code: id, duration: 10, shift: "正常", damage: "完好", note: "", thumb: "", ...partial };
}
function reel(id, partial) {
  return {
    id,
    title: id,
    status: "draft",
    finalizedAt: null,
    slots: [],
    runOrder: [],
    ...partial
  };
}
function slot(id, segmentId, partial) {
  return { id, segmentId, substituteId: null, substituteCancelled: false, ...partial };
}

test("不重叠修改自动合并：左改字段、右加片段、双方各改不同字段", () => {
  const base = state({ library: [seg("a", { duration: 10, note: "old" })], reels: [] });
  const left = state({ library: [seg("a", { duration: 10, note: "left note" })], reels: [] });
  const right = state({ library: [seg("a", { duration: 12, note: "old" }), seg("b")], reels: [] });
  const out = mergeThreeWay(base, left, right);
  assert.equal(out.resolved, true);
  assert.equal(out.conflicts.length, 0);
  const a = out.state.library.find((s) => s.id === "a");
  assert.equal(a.note, "left note");
  assert.equal(a.duration, 12);
  assert.ok(out.state.library.some((s) => s.id === "b"));
  assert.ok(out.stats.segmentsAdded >= 1);
});

test("双方改同一字段为不同值 -> 冲突，必须裁决；未裁决不能定案", () => {
  const base = state({ library: [seg("a", { duration: 10 })] });
  const left = state({ library: [seg("a", { duration: 11 })] });
  const right = state({ library: [seg("a", { duration: 12 })] });
  const pending = mergeThreeWay(base, left, right);
  assert.equal(pending.resolved, false);
  assert.equal(pending.unresolvedCount, 1);
  assert.deepEqual(pending.conflicts[0].choices, ["left", "right"]);
  assert.equal(pending.state.library[0].duration, 11); // 占位为左

  const picked = mergeThreeWay(base, left, right, { [pending.conflicts[0].key]: "right" });
  assert.equal(picked.resolved, true);
  assert.equal(picked.state.library[0].duration, 12);
});

test("一方删除片段、另一方修改 -> delete/keep 冲突，默认不静默删除", () => {
  const base = state({ library: [seg("a", { note: "old" })] });
  const left = state({ library: [] });
  const right = state({ library: [seg("a", { note: "edited" })] });
  const pending = mergeThreeWay(base, left, right);
  assert.equal(pending.resolved, false);
  assert.equal(pending.conflicts[0].kind, "delete-modify");
  // 不裁决：片段保留在占位结果中
  assert.ok(pending.state.library.some((s) => s.id === "a"));

  const kept = mergeThreeWay(base, left, right, { "segment:a:delete-modify": "keep" });
  assert.equal(kept.state.library.length, 1);
  const deleted = mergeThreeWay(base, left, right, { "segment:a:delete-modify": "delete" });
  assert.equal(deleted.state.library.length, 0);
});

test("删除共享片段但仍有卷引用 -> 引用冲突；维持删除则引用悬空留给阻断流程", () => {
  const base = state({
    library: [seg("a")],
    reels: [reel("r1", { slots: [slot("sl1", "a")] })]
  });
  const left = state({ library: [], reels: [reel("r1", { slots: [slot("sl1", "a")] })] });
  const right = state({ library: [seg("a")], reels: [reel("r1", { title: "r1-renamed", slots: [slot("sl1", "a")] })] });
  const pending = mergeThreeWay(base, left, right);
  const refConflict = pending.conflicts.find((c) => c.kind === "reference");
  assert.ok(refConflict, "应产生引用完整性冲突");
  // 默认/keep 恢复片段
  const kept = mergeThreeWay(base, left, right, { [refConflict.key]: "keep" });
  assert.ok(kept.state.library.some((s) => s.id === "a"));
  assert.equal(kept.resolved, true);
  // delete 维持删除，卷引用悬空
  const cut = mergeThreeWay(base, left, right, { [refConflict.key]: "delete" });
  assert.equal(cut.state.library.length, 0);
  assert.equal(cut.state.reels[0].slots[0].segmentId, "a");
});

test("双方各自加卷互不影响；一边加卷另一边删同一旧卷", () => {
  const base = state({ reels: [reel("r1")] });
  const left = state({ reels: [reel("r1"), reel("r2", { title: "左加的卷" })] });
  const right = state({ reels: [reel("r3", { title: "右加的卷" })] });
  const out = mergeThreeWay(base, left, right);
  assert.equal(out.resolved, true);
  const titles = out.state.reels.map((r) => r.title).sort();
  assert.deepEqual(titles, ["右加的卷", "左加的卷"]);
});

test("排片顺序双方都调整且不一致 -> 顺序冲突二选一；单边调整自动合并新增片段", () => {
  const base = state({
    library: [seg("a"), seg("b"), seg("c"), seg("d")],
    reels: [reel("r1", { slots: [slot("1", "a"), slot("2", "b"), slot("3", "c")] })]
  });
  // 左：b,a,c + 新片段 d 放最前；右：a,c,b
  const left = state({
    library: base.library,
    reels: [reel("r1", { slots: [slot("0", "d"), slot("2", "b"), slot("1", "a"), slot("3", "c")] })]
  });
  const right = state({
    library: base.library,
    reels: [reel("r1", { slots: [slot("1", "a"), slot("3", "c"), slot("2", "b")] })]
  });
  const pending = mergeThreeWay(base, left, right);
  const orderConflict = pending.conflicts.find((c) => c.kind === "order");
  assert.ok(orderConflict, "双方不同顺序调整应冲突");
  const useLeft = mergeThreeWay(base, left, right, { [orderConflict.key]: "left" });
  assert.deepEqual(useLeft.state.reels[0].slots.map((s) => s.id), ["0", "2", "1", "3"]);
  const useRight = mergeThreeWay(base, left, right, { [orderConflict.key]: "right" });
  // 右边没有 d，d 附在末尾
  assert.deepEqual(useRight.state.reels[0].slots.map((s) => s.id), ["1", "3", "2", "0"]);

  // 只有左边重排、右边改别的 -> 自动合并，保留左顺序并带上右修改
  const right2 = state({
    library: base.library,
    reels: [reel("r1", { title: "new title", slots: [slot("1", "a"), slot("2", "b"), slot("3", "c")] })]
  });
  const auto = mergeThreeWay(base, left, right2);
  assert.equal(auto.resolved, true);
  assert.deepEqual(auto.state.reels[0].slots.map((s) => s.id), ["0", "2", "1", "3"]);
  assert.equal(auto.state.reels[0].title, "new title");
});

test("排练记录：延误原因字段两边不同 -> 字段冲突", () => {
  const base = state({
    reels: [
      reel("r1", {
        slots: [slot("1", "a")],
        runOrder: [{ slotId: "1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }]
      })
    ]
  });
  const left = state({
    reels: [
      reel("r1", {
        slots: [slot("1", "a")],
        runOrder: [{ slotId: "1", order: 1, source: "primary", delay: 5, delayReason: "左侧原因", replaceReason: "" }]
      })
    ]
  });
  const right = state({
    reels: [
      reel("r1", {
        slots: [slot("1", "a")],
        runOrder: [{ slotId: "1", order: 1, source: "primary", delay: 5, delayReason: "右侧原因", replaceReason: "" }]
      })
    ]
  });
  const pending = mergeThreeWay(base, left, right);
  assert.equal(pending.resolved, false);
  assert.ok(pending.conflicts[0].message.includes("延误原因"));
  const picked = mergeThreeWay(base, left, right, { [pending.conflicts[0].key]: "right" });
  assert.equal(picked.state.reels[0].runOrder[0].delayReason, "右侧原因");
});

test("一边改替代、一边改同 slot 的别的字段 -> 自动合并", () => {
  const base = state({
    library: [seg("a"), seg("b"), seg("c")],
    reels: [reel("r1", { slots: [slot("1", "a")] })]
  });
  const left = state({ library: base.library, reels: [reel("r1", { slots: [slot("1", "a", { substituteId: "b" })] })] });
  const right = state({ library: base.library, reels: [reel("r1", { slots: [slot("1", "a", { substituteCancelled: true })] })] });
  const out = mergeThreeWay(base, left, right);
  assert.equal(out.resolved, true);
  assert.equal(out.state.reels[0].slots[0].substituteId, "b");
  assert.equal(out.state.reels[0].slots[0].substituteCancelled, true);
});

test("同一 slot 一边删除一边挂替代 -> delete/keep 冲突", () => {
  const base = state({ library: [seg("a"), seg("b")], reels: [reel("r1", { slots: [slot("1", "a")] })] });
  const left = state({ library: base.library, reels: [reel("r1", { slots: [] })] });
  const right = state({ library: base.library, reels: [reel("r1", { slots: [slot("1", "a", { substituteId: "b" })] })] });
  const pending = mergeThreeWay(base, left, right);
  assert.ok(pending.conflicts.some((c) => c.kind === "delete-modify"));
});
