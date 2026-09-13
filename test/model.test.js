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

test("原片段已删除但有替代时：可继续核对，排练必须用替代+原因", () => {
  // 库里只剩替代片段，slot 引用的原片段已删除
  const sub = seg("sub1", { duration: 12, shift: "正常", damage: "完好" });
  const reel = M.createReel({
    slots: [{ id: "sl1", segmentId: "gone", substituteId: "sub1", substituteCancelled: false }]
  });

  // 未排练：仍有阻断（未排练，而不是"引用缺失"）
  const before = M.reelBlockers(reel, [sub]);
  assert.equal(before.some((b) => b.kind === "missing"), false);
  assert.ok(before.some((b) => b.kind === "rehearsal"));

  // 排练为原片 -> 来源矛盾阻断
  const wrong = M.createReel({
    slots: reel.slots,
    runOrder: [{ slotId: "sl1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }]
  });
  assert.ok(M.reelBlockers(wrong, [sub]).some((b) => b.kind === "source"));

  // 排练为替代但无替换原因 -> reason 阻断
  const noReason = M.createReel({
    slots: reel.slots,
    runOrder: [{ slotId: "sl1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "" }]
  });
  assert.ok(M.reelBlockers(noReason, [sub]).some((b) => b.kind === "reason"));

  // 全部正确 -> 无阻断，可以定版；冻结快照只含替代
  const ready = M.createReel({
    slots: reel.slots,
    runOrder: [{ slotId: "sl1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "原片已删除" }]
  });
  assert.equal(M.reelBlockers(ready, [sub]).length, 0);
  const done = M.finalizeReel(ready, [sub]);
  assert.equal(done.ok, true);
  assert.deepEqual(done.reel.frozenLibrary.map((s) => s.id), ["sub1"]);
  // 定版卷按替代时长计算，且库再变不影响
  assert.equal(M.reelDuration(done.reel, []), 12);

  // 原片删除且没有替代 -> 仍然阻断
  const noSub = M.createReel({ slots: [{ id: "sl2", segmentId: "gone2", substituteId: null, substituteCancelled: false }] });
  assert.ok(M.reelBlockers(noSub, [sub]).some((b) => b.kind === "missing"));
});

test("需跳过原片挂合规替代后，排练必须实际使用替代", () => {
  const p = seg("p1", { damage: "需跳过", duration: 10 });
  const s = seg("s1", { duration: 11, damage: "完好" });
  const reel = M.createReel({
    slots: [{ id: "sl1", segmentId: "p1", substituteId: "s1", substituteCancelled: false }],
    runOrder: [{ slotId: "sl1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }]
  });
  assert.ok(M.reelBlockers(reel, [p, s]).some((b) => b.kind === "source"));
  const fixed = M.createReel({
    slots: reel.slots,
    runOrder: [{ slotId: "sl1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "跳过原片" }]
  });
  assert.equal(M.reelBlockers(fixed, [p, s]).length, 0);
});

test("导入：定版卷缺冻结快照 / 快照不全 -> 拒绝", () => {
  const lib = [{ id: "a", code: "A", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" }];
  const finalizedNoFrozen = {
    library: lib,
    reels: [
      { id: "r1", title: "定版卷", status: "finalized", finalizedAt: 1, slots: [{ id: "s1", segmentId: "a" }], runOrder: [] }
    ]
  };
  const r1 = M.validateProject(finalizedNoFrozen);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.path.endsWith("frozenLibrary")));

  const incompleteFrozen = {
    library: lib,
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "a" }],
        runOrder: [],
        frozenLibrary: []
      }
    ]
  };
  const r2 = M.validateProject(incompleteFrozen);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /冻结快照缺少/.test(e.message)));

  // 快照完整 -> 通过
  const complete = {
    library: lib,
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "a" }],
        runOrder: [],
        frozenLibrary: [lib[0]]
      }
    ]
  };
  const r3 = M.validateProject(complete);
  assert.equal(r3.ok, true);
  assert.equal(r3.state.reels[0].frozenLibrary.length, 1);
});

test("导入：同一排片位置多条排练记录 -> 拒绝；顺序号重复 -> 拒绝", () => {
  const lib = [{ id: "a", code: "A", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" }];
  const dup = {
    library: lib,
    reels: [
      {
        id: "r1",
        title: "卷",
        slots: [{ id: "s1", segmentId: "a" }],
        runOrder: [
          { slotId: "s1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" },
          { slotId: "s1", order: 2, source: "substitute", delay: 0, delayReason: "", replaceReason: "" }
        ]
      }
    ]
  };
  const r1 = M.validateProject(dup);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /多条排练记录/.test(e.message)));

  const dupOrder = {
    library: lib,
    reels: [
      {
        id: "r1",
        title: "卷",
        slots: [{ id: "s1", segmentId: "a" }, { id: "s2", segmentId: "a" }],
        runOrder: [
          { slotId: "s1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" },
          { slotId: "s2", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }
        ]
      }
    ]
  };
  const r2 = M.validateProject(dupOrder);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /顺序号 1 重复/.test(e.message)));
});

test("导入：原片段悬空但有库内替代 -> 允许（警告）并以替代继续", () => {
  const sub = { id: "sub", code: "SUB", duration: 12, shift: "正常", damage: "完好", note: "", thumb: "" };
  const r = M.validateProject({
    library: [sub],
    reels: [
      {
        id: "r1",
        title: "卷",
        slots: [{ id: "s1", segmentId: "gone-primary", substituteId: "sub", substituteCancelled: false }],
        runOrder: [{ slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "原片已删" }]
      }
    ]
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /以替代继续/.test(w.message)));
  assert.equal(M.reelBlockers(r.state.reels[0], r.state.library).length, 0);
});

test("导入：定版记录声明替代放映但没有替代候选 -> 拒绝并说清位置与原因", () => {
  const lib = [{ id: "f1", code: "F-1", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" }];
  const noCandidate = {
    library: lib,
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: null }],
        runOrder: [{ slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "x" }],
        frozenLibrary: [lib[0]]
      }
    ]
  };
  const r1 = M.validateProject(noCandidate);
  assert.equal(r1.ok, false);
  const err1 = r1.errors.find((e) => /没有安排可用替代候选/.test(e.message));
  assert.ok(err1, "应给出无替代候选错误");
  assert.match(err1.message, /第1位/);
  assert.match(err1.message, /s1/);

  // 声明替代，候选在库中但被冻结快照遗漏（与 requiredIds 报"快照缺少"是同一缺口，
  // 来源一致性检查则明确指出是哪一条排练记录）
  const ghostSub = {
    library: [
      lib[0],
      { id: "f2", code: "F-2", duration: 12, shift: "正常", damage: "完好", note: "", thumb: "" }
    ],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: "f2" }],
        runOrder: [{ slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "x" }],
        frozenLibrary: [lib[0]]
      }
    ]
  };
  const r2 = M.validateProject(ghostSub);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /不在定版冻结快照中/.test(e.message)));

  // 声明原片放映但原片已删除（仅有替代）-> 同样拒绝
  const primaryGone = {
    library: [{ id: "f2", code: "F-2", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" }],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "gone", substituteId: "f2" }],
        runOrder: [{ slotId: "s1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }],
        frozenLibrary: [{ id: "f2", code: "F-2", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" }]
      }
    ]
  };
  const r3 = M.validateProject(primaryGone);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => /原片段「gone」已不在片段库/.test(e.message)));
});

test("导入：合法定版工程（替代来源 + 候选在快照中）通过", () => {  const primary = { id: "f1", code: "F-1", duration: 10, shift: "正常", damage: "需跳过", note: "", thumb: "" };
  const substitute = { id: "f2", code: "F-2", duration: 11, shift: "正常", damage: "完好", note: "", thumb: "" };
  const project = {
    library: [primary, substitute],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: "f2" }, { id: "s2", segmentId: "f2", substituteId: null }],
        runOrder: [
          { slotId: "s1", order: 1, source: "substitute", delay: 3, delayReason: "换机", replaceReason: "原片需跳过" },
          { slotId: "s2", order: 2, source: "primary", delay: 0, delayReason: "", replaceReason: "" }
        ],
        frozenLibrary: [primary, substitute]
      }
    ]
  };
  const r = M.validateProject(project);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 定版卷按替代时长计算 s1
  assert.equal(M.reelDuration(r.state.reels[0], r.state.library), 22);
});

test("导入：替代已取消（保留编号）时声明替代放映 -> 拒绝；声明原片则通过", () => {
  const f1 = { id: "f1", code: "F-1", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" };
  const f2 = { id: "f2", code: "F-2", duration: 11, shift: "正常", damage: "完好", note: "", thumb: "" };

  // 取消替代后仍声明替代放映 -> 拒绝，指出位置与取消状态
  const cancelledButSubSource = {
    library: [f1, f2],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: "f2", substituteCancelled: true }],
        runOrder: [{ slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "x" }],
        frozenLibrary: [f1, f2]
      }
    ]
  };
  const r1 = M.validateProject(cancelledButSubSource);
  assert.equal(r1.ok, false);
  const err = r1.errors.find((e) => /已标记取消/.test(e.message));
  assert.ok(err, JSON.stringify(r1.errors));
  assert.match(err.message, /第1位/);
  assert.match(err.message, /f2/);

  // 取消替代、声明原片放映 -> 通过；冻结快照不要求 f2
  const cancelledPrimarySource = {
    library: [f1, f2],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: "f2", substituteCancelled: true }],
        runOrder: [{ slotId: "s1", order: 1, source: "primary", delay: 0, delayReason: "", replaceReason: "" }],
        frozenLibrary: [f1]
      }
    ]
  };
  const r2 = M.validateProject(cancelledPrimarySource);
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  // 生效片段为原片 f1（10s）
  assert.equal(M.reelDuration(r2.state.reels[0], r2.state.library), 10);

  // 取消替代且原片也缺失 -> 位置级错误
  const cancelledAndPrimaryGone = {
    library: [f2],
    reels: [
      {
        id: "r1",
        title: "卷",
        slots: [{ id: "s1", segmentId: "gone", substituteId: "f2", substituteCancelled: true }],
        runOrder: []
      }
    ]
  };
  const r3 = M.validateProject(cancelledAndPrimaryGone);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => /没有可用替代片段（替代已取消）/.test(e.message)));
});

test("导入：合法定版工程（替代未取消 + 候选在快照中 + 替代来源）通过", () => {
  const f1 = { id: "f1", code: "F-1", duration: 10, shift: "正常", damage: "完好", note: "", thumb: "" };
  const f2 = { id: "f2", code: "F-2", duration: 11, shift: "正常", damage: "完好", note: "", thumb: "" };
  const project = {
    library: [f1, f2],
    reels: [
      {
        id: "r1",
        title: "定版卷",
        status: "finalized",
        finalizedAt: 1,
        slots: [{ id: "s1", segmentId: "f1", substituteId: "f2", substituteCancelled: false }],
        runOrder: [{ slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "原因" }],
        frozenLibrary: [f1, f2]
      }
    ]
  };
  const r = M.validateProject(project);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(M.reelDuration(r.state.reels[0], r.state.library), 11);
});

test("导出 -> 再导入往返：自己生成的定版工程（含替代来源）合法", () => {
  // 先在模型内完成"排片+挂替代+排练+定版"，再按 toProject 导出，校验导出结果可直接再导入
  const primary = seg("p1", { duration: 10, damage: "需跳过" });
  const sub = seg("sub1", { duration: 11, damage: "完好" });
  const other = seg("o1", { duration: 20 });
  const draft = M.createReel({
    title: "往返卷",
    slots: [
      { id: "s1", segmentId: "p1", substituteId: "sub1", substituteCancelled: false },
      { id: "s2", segmentId: "o1", substituteId: null, substituteCancelled: false }
    ],
    runOrder: [
      { slotId: "s1", order: 1, source: "substitute", delay: 0, delayReason: "", replaceReason: "跳过" },
      { slotId: "s2", order: 2, source: "primary", delay: 0, delayReason: "", replaceReason: "" }
    ]
  });
  const done = M.finalizeReel(draft, [primary, sub, other]);
  assert.equal(done.ok, true);
  const projectState = { schemaVersion: M.SCHEMA_VERSION, library: [primary, sub, other], reels: [done.reel], activeReelId: done.reel.id };
  const exported = M.toProject(projectState);
  const reimport = M.validateProject(exported);
  assert.equal(reimport.ok, true, JSON.stringify(reimport.errors));
  assert.equal(reimport.state.reels[0].status, "finalized");
  assert.equal(M.reelBlockers(reimport.state.reels[0], reimport.state.library).length, 0);
  assert.equal(M.reelDuration(reimport.state.reels[0], reimport.state.library), 31);
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
