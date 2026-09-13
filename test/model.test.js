const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");

function seg(id, partial) {
  return M.createSegment({ id, code: id, duration: 10, shift: "正常", damage: "完好", note: "", ...partial, id });
}

test("替代约束：颜色一致、破损不更严重、时长在容差内才算合规", () => {
  const primary = { id: "p", code: "P", duration: 20, shift: "偏红", damage: "轻微划痕" };
  const ok = { id: "a", code: "A", duration: 22, shift: "偏红", damage: "完好" };
  const badColor = { id: "b", code: "B", duration: 20, shift: "正常", damage: "完好" };
  const badDamage = { id: "c", code: "C", duration: 20, shift: "偏红", damage: "齿孔破损" };
  const badDuration = { id: "d", code: "D", duration: 30, shift: "偏红", damage: "完好" };

  assert.equal(M.substitutionConflicts(primary, ok).length, 0);
  assert.ok(M.substitutionConflicts(primary, badColor).some((c) => c.type === "color"));
  assert.ok(M.substitutionConflicts(primary, badDamage).some((c) => c.type === "damage"));
  assert.ok(M.substitutionConflicts(primary, badDuration).some((c) => c.type === "duration"));

  // 容差边界：20 秒 -> ±max(2, 3) = 3
  assert.equal(M.durationTolerance(20), 3);
  assert.equal(M.substitutionConflicts(primary, { ...ok, duration: 23 }).length, 0);
  assert.ok(M.substitutionConflicts(primary, { ...ok, duration: 24 }).some((c) => c.type === "duration"));

  const all = M.eligibleSubstitutes(primary, [ok, badColor, badDamage, badDuration, primary]);
  assert.equal(all[0].segment.id, "a");
  assert.ok(!all.some((x) => x.segment.id === "p"));
});

test("共享片段修改后，两卷时长与风险自动重算", () => {
  const s1 = seg("s1", { duration: 10, shift: "正常", damage: "完好" });
  const s2 = seg("s2", { duration: 15, shift: "褪色", damage: "接片松动" });
  const reels = [
    M.createReel({ slots: [M.createSlot("s1"), M.createSlot("s2")] }),
    M.createReel({ slots: [M.createSlot("s2")] })
  ];
  const library = [s1, s2];

  assert.equal(M.reelDuration(reels[0], library), 25);
  assert.equal(M.reelDuration(reels[1], library), 15);
  const riskBefore = M.reelRisk(reels[1], library);
  assert.ok(riskBefore >= 4);

  // 修改共享片段：时长 +5，破损升级（齿孔破损→需跳过）-> 所有引用卷同步
  const updated = library.map((item) => (item.id === "s2" ? { ...item, duration: 20, damage: "需跳过" } : item));
  assert.equal(M.reelDuration(reels[0], updated), 30);
  assert.equal(M.reelDuration(reels[1], updated), 20);
  assert.ok(M.reelRisk(reels[1], updated) > riskBefore);
});

test("替代片段生效时，卷时长按替代计算", () => {
  const s1 = seg("s1", { duration: 10 });
  const s2 = seg("s2", { duration: 30 });
  const reel = M.createReel({ slots: [{ id: "slot-1", segmentId: "s1", substituteId: "s2", substituteCancelled: false }] });
  assert.equal(M.reelDuration(reel, [s1, s2]), 30);
  const cancelled = M.createReel({ slots: [{ id: "slot-1", segmentId: "s1", substituteId: "s2", substituteCancelled: true }] });
  assert.equal(M.reelDuration(cancelled, [s1, s2]), 10);
});

test("阻断：未排练 / 缺替换原因 / 延误缺说明 / 需跳过无替代 / 冲突替代", () => {
  const s1 = seg("s1", { duration: 10 });
  const s2 = seg("s2", { duration: 10, damage: "需跳过" });
  const s3 = seg("s3", { duration: 10, shift: "正常" });
  const s4 = seg("s4", { duration: 10, shift: "偏青" }); // 颜色冲突替代
  const reel = M.createReel({
    slots: [
      M.createSlot("s1"), // 未排练
      M.createSlot("s2"), // 需跳过，无替代
      { id: "slot3", segmentId: "s3", substituteId: "s4", substituteCancelled: false }
    ],
    runOrder: [
      { slotId: "slot3", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "" }
    ]
  });
  const blockers = M.reelBlockers(reel, [s1, s2, s3, s4]);
  const kinds = blockers.map((b) => b.kind);
  assert.ok(kinds.includes("rehearsal"));
  assert.ok(kinds.includes("must-skip"));
  assert.ok(kinds.includes("conflict"));
  assert.ok(kinds.includes("reason"));

  // 全部处理完 -> 无阻断
  const fixed = M.createReel({
    slots: [
      { id: "slot1", segmentId: "s1", substituteId: null, substituteCancelled: false },
      { id: "slot2", segmentId: "s2", substituteId: "s1", substituteCancelled: false },
      { id: "slot3", segmentId: "s3", substituteId: null, substituteCancelled: false }
    ],
    runOrder: [
      { slotId: "slot1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" },
      { slotId: "slot2", order: 2, source: "substitute", delay: 5, delayReason: "换片等待", replaceReason: "原片需跳过" },
      { slotId: "slot3", order: 3, source: "primary", delay: 0, delayReason: "", replaceReason: "" }
    ]
  });
  assert.equal(M.reelBlockers(fixed, [s1, s2, s3, s4]).length, 0);
});

test("阻断：延误有秒数但缺原因；定版卷不再报阻断", () => {
  const s1 = seg("s1");
  const reel = M.createReel({
    status: "finalized",
    slots: [{ id: "slot1", segmentId: "s1", substituteId: null, substituteCancelled: false }],
    runOrder: []
  });
  assert.equal(M.reelBlockers(reel, [s1]).length, 0);

  const draft = M.createReel({
    slots: [{ id: "slot1", segmentId: "s1", substituteId: null, substituteCancelled: false }],
    runOrder: [{ slotId: "slot1", order: 1, source: "primary", delay: 9, delayReason: "", replaceReason: "" }]
  });
  assert.ok(M.reelBlockers(draft, [s1]).some((b) => b.kind === "delay-reason"));
});

test("旧版单卷数据迁移为 共享库+一卷引用", () => {
  const legacy = {
    reelTitle: "旧卷",
    segments: [
      { id: "x1", code: "A-1", duration: 11, shift: "偏黄", damage: "完好", note: "n", thumb: "" },
      { id: "x2", code: "A-2", duration: 12, shift: "正常", damage: "齿孔破损", note: "", thumb: "" }
    ]
  };
  const migrated = M.migrateLegacy(legacy);
  assert.equal(migrated.library.length, 2);
  assert.equal(migrated.reels.length, 1);
  assert.deepEqual(
    migrated.reels[0].slots.map((s) => s.segmentId),
    ["x1", "x2"]
  );
  assert.equal(M.reelDuration(migrated.reels[0], migrated.library), 23);
  assert.equal(M.migrateLegacy("not json"), null);
});

test("导入校验：结构错误逐条列出，不产出 state", () => {
  const bad = M.validateProject({
    library: [
      { id: "a", code: "A", duration: 10, shift: "正常", damage: "完好" },
      { id: "a", code: "A2", duration: 10, shift: "正常", damage: "完好" },
      { id: "b", duration: -3, shift: "正常", damage: "完好" }
    ],
    reels: [
      {
        id: "r1",
        title: "卷一",
        slots: [{ id: "sl1", segmentId: "ghost" }]
      }
    ]
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path.includes("id") && /重复/.test(e.message)));
  assert.ok(bad.errors.some((e) => e.path.endsWith("duration")));
  assert.ok(bad.errors.some((e) => /不在片段库/.test(e.message)));
  assert.equal(bad.state, null);

  // 非致命问题只告警并自动修复
  const warn = M.validateProject({
    library: [{ id: "a", code: "A", duration: 10, shift: "奇怪色", damage: "完好" }],
    reels: [{ id: "r1", slots: [{ id: "sl1", segmentId: "a", substituteId: "missing" }] }]
  });
  assert.equal(warn.ok, true);
  assert.ok(warn.warnings.some((w) => /颜色偏移/.test(w.message)));
  assert.equal(warn.state.reels[0].slots[0].substituteId, null);
});

test("风险分级与时长格式化", () => {
  assert.equal(M.formatDuration(0), "0:00");
  assert.equal(M.formatDuration(83), "1:23");
  assert.equal(M.riskLevel(M.segmentRisk({ shift: "正常", damage: "完好" })).level, "safe");
  assert.equal(M.riskLevel(M.segmentRisk({ shift: "褪色", damage: "需跳过" })).level, "high");
});

test("提醒按卷输出颜色与破损项，替代生效时以替代内容提醒", () => {
  const s1 = seg("s1", { shift: "偏红", damage: "完好" });
  const s2 = seg("s2", { shift: "正常", damage: "完好" });
  const reel = M.createReel({ slots: [{ id: "sl1", segmentId: "s1", substituteId: "s2", substituteCancelled: false }] });
  const warnings = M.reelWarnings(reel, [s1, s2]);
  assert.equal(warnings.length, 0);
});

test("有阻断不能定版；定版后冻结库快照，共享库后续修改不影响定版卷", () => {
  const s1 = seg("s1", { duration: 10 });
  const blocked = M.createReel({ slots: [M.createSlot("s1")] });
  assert.equal(M.finalizeReel(blocked, [s1]).ok, false);

  const ready = M.createReel({
    slots: [{ id: "sl1", segmentId: "s1", substituteId: null, substituteCancelled: false }],
    runOrder: [{ slotId: "sl1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }]
  });
  const done = M.finalizeReel(ready, [s1]);
  assert.equal(done.ok, true);
  assert.equal(done.reel.status, "finalized");
  assert.equal(done.reel.frozenLibrary.length, 1);

  // 库里片段被改时长/删除，定版卷保持快照值
  const mutatedLib = [{ ...s1, duration: 99 }];
  assert.equal(M.reelDuration(done.reel, mutatedLib), 10);
  assert.equal(M.reelDuration(done.reel, []), 10);
  assert.equal(M.reelBlockers(done.reel, []).length, 0);

  const reopened = M.unfinalizeReel(done.reel);
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.frozenLibrary, null);
  assert.equal(M.reelDuration(reopened, mutatedLib), 99);
});
