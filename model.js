/*
 * 多卷联映排练台 —— 领域模型与纯函数
 * 片段库(library)被多卷(reels)共享；卷以 slot 引用库片段，可挂替代片段。
 * 本文件不触碰 DOM，可直接在 Node 中被单元测试引用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FilmModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SHIFTS = ["正常", "偏红", "偏青", "偏黄", "褪色"];
  const DAMAGES = ["完好", "轻微划痕", "齿孔破损", "接片松动", "需跳过"];
  const DAMAGE_RANK = { 完好: 0, 轻微划痕: 1, 齿孔破损: 2, 接片松动: 3, 需跳过: 4 };
  // 时长容差：绝对 2 秒或原时长的 15%，取较大值
  const DURATION_TOLERANCE_RATIO = 0.15;
  const DURATION_TOLERANCE_MIN = 2;
  const STORAGE_KEY = "zfl17-film-rehearsal-stage";
  const LEGACY_STORAGE_KEY = "zfl17-film-strip-desk";
  const SCHEMA_VERSION = 2;
  const HISTORY_LIMIT = 60;

  function uid(prefix) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return (prefix || "") + crypto.randomUUID();
    return (
      (prefix || "") +
      "id-" +
      Date.now().toString(36) +
      "-" +
      Math.floor(Math.random() * 1e9).toString(36)
    );
  }

  function durationTolerance(duration) {
    return Math.max(DURATION_TOLERANCE_MIN, Math.round(Number(duration) * DURATION_TOLERANCE_RATIO));
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(value / 60);
    const rest = String(value % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  /* ---------------- 风险 ---------------- */

  function segmentRisk(segment) {
    if (!segment) return 0;
    let score = 0;
    if (segment.shift && segment.shift !== "正常") score += 1;
    score += DAMAGE_RANK[segment.damage] || 0;
    return score;
  }

  function riskLevel(score) {
    if (score <= 0) return { level: "safe", label: "无风险" };
    if (score <= 1) return { level: "low", label: "低风险" };
    if (score <= 3) return { level: "mid", label: "中风险" };
    return { level: "high", label: "高风险" };
  }

  function describeRisk(segment) {
    const parts = [];
    if (segment.shift && segment.shift !== "正常") parts.push(segment.shift);
    if (segment.damage && segment.damage !== "完好") parts.push(segment.damage);
    return parts.join(" · ");
  }

  /* ---------------- 派生查询 ---------------- */

  // 卷中一个位置当前实际生效的片段（有替代且未取消则用替代）
  function effectiveSegment(reel, slot) {
    if (slot && slot.substituteId && !slot.substituteCancelled) {
      return reel._libById ? reel._libById.get(slot.substituteId) || null : null;
    }
    return reel._libById ? reel._libById.get(slot.segmentId) || null : null;
  }

  // 卷中一个位置当前实际生效的片段（有替代且未取消则用替代；定版冻结快照优先）
  function effectiveLibForReel(reel, library) {
    if (reel.frozenLibrary) return reel.frozenLibrary;
    return library;
  }

  function reelSlotsWithSegments(reel, library) {
    const lib = effectiveLibForReel(reel, library);
    const byId = new Map(lib.map((item) => [item.id, item]));
    return reel.slots.map((slot) => {
      const primary = byId.get(slot.segmentId) || null;
      const substitute = slot.substituteId && !slot.substituteCancelled ? byId.get(slot.substituteId) || null : null;
      return { slot, primary, substitute, effective: substitute || primary };
    });
  }

  function reelDuration(reel, library) {
    return reelSlotsWithSegments(reel, library).reduce((sum, row) => sum + (row.effective ? Number(row.effective.duration) || 0 : 0), 0);
  }

  function reelRisk(reel, library) {
    return reelSlotsWithSegments(reel, library).reduce((sum, row) => sum + segmentRisk(row.effective), 0);
  }

  function reelStats(reel, library) {
    const rows = reelSlotsWithSegments(reel, library);
    let duration = 0;
    let risk = 0;
    let damageCount = 0;
    let missing = 0;
    for (const row of rows) {
      if (!row.effective) {
        missing += 1;
        continue;
      }
      duration += Number(row.effective.duration) || 0;
      risk += segmentRisk(row.effective);
      if (row.effective.damage !== "完好") damageCount += 1;
    }
    return { duration, risk, damageCount, missing, slotCount: rows.length };
  }

  /* ---------------- 替代约束 ---------------- */

  // 逐条返回替代片段与原片段之间的冲突；空数组表示满足全部约束
  function substitutionConflicts(primary, candidate) {
    const conflicts = [];
    if (!primary) return conflicts;
    if (!candidate) {
      conflicts.push({ type: "missing", message: "候选片段不存在。" });
      return conflicts;
    }
    if (candidate.id === primary.id) {
      conflicts.push({ type: "same", message: "候选片段与原片段相同，不能作为替代。" });
    }
    if (candidate.shift !== primary.shift) {
      conflicts.push({
        type: "color",
        message: `颜色不匹配：原片段为「${primary.shift}」，候选为「${candidate.shift}」。`
      });
    }
    if ((DAMAGE_RANK[candidate.damage] ?? 0) > (DAMAGE_RANK[primary.damage] ?? 0)) {
      conflicts.push({
        type: "damage",
        message: `破损更严重：原片段为「${primary.damage}」，候选为「${candidate.damage}」。`
      });
    }
    const tolerance = durationTolerance(primary.duration);
    const diff = Math.abs(Number(candidate.duration) - Number(primary.duration));
    if (diff > tolerance) {
      conflicts.push({
        type: "duration",
        message: `时长超差：原片段 ${formatDuration(primary.duration)}（容差 ±${tolerance} 秒），候选 ${formatDuration(candidate.duration)}，相差 ${diff} 秒。`
      });
    }
    return conflicts;
  }

  function eligibleSubstitutes(primary, library) {
    if (!primary) return [];
    return library
      .filter((item) => item.id !== primary.id)
      .map((item) => ({ segment: item, conflicts: substitutionConflicts(primary, item) }))
      .sort((a, b) => a.conflicts.length - b.conflicts.length || a.segment.code.localeCompare(b.segment.code, "zh"));
  }

  /* ---------------- 阻断（未处理阻断不能定版） ---------------- */

  /**
   * 逐条列出卷当前未处理的阻断。
   * 处理方式：
   *  - 原片段引用缺失：若已安排"合规替代"则该位置可继续核对（排练必须实际使用替代）；
   *    没有替代时必须移除位置或安排替代。
   *  - 替代冲突：取消替代，或换为满足颜色/破损/时长约束的片段。
   *  - 需跳过原片：挂合规替代并记录替换原因。
   *  - 排练未完成：所有位置都要有实际顺序记录。
   *  - 原片缺失却排练为"原片"、合规替代却排练为"原片"以外的矛盾来源 -> 阻断。
   *  - 延误未说明：实际延误 > 0 的位置必须填写延误说明。
   *  - 替换原因缺失：使用替代的位置必须填写替换原因。
   */
  function reelBlockers(reel, library) {
    const blockers = [];
    if (reel.status === "finalized") return blockers;
    const rows = reelSlotsWithSegments(reel, library);
    const orderMap = new Map();
    (reel.runOrder || []).forEach((entry) => {
      if (entry && entry.slotId && !orderMap.has(entry.slotId)) orderMap.set(entry.slotId, entry);
    });

    rows.forEach((row, index) => {
      const pos = index + 1;
      const label = row.primary
        ? `第${pos}位「${row.primary.code}」`
        : row.substitute
          ? `第${pos}位（原片段已删除，以替代「${row.substitute.code}」继续）`
          : `第${pos}位（原片段缺失）`;

      // 替代合规性：原片在场时按三条约束核对；原片缺失时替代本身是唯一可用内容，
      // 其颜色/破损/时长已在安排时由用户确认，不再以缺失原片比对
      let subConflicts = [];
      if (!row.primary) {
        if (!row.substitute) {
          blockers.push({
            key: `${row.slot.id}:missing`,
            severity: "block",
            kind: "missing",
            message: `第${pos}位：引用的共享片段已删除，且没有替代片段，需移除该位置或安排替代。`
          });
        }
      } else if (row.substitute) {
        subConflicts = substitutionConflicts(row.primary, row.substitute);
        subConflicts.forEach((conflict, i) => {
          blockers.push({
            key: `${row.slot.id}:conflict:${conflict.type}:${i}`,
            severity: "block",
            kind: "conflict",
            message: `${label} 的替代「${row.substitute.code}」不满足约束——${conflict.message}`
          });
        });
      } else if (row.primary.damage === "需跳过") {
        blockers.push({
          key: `${row.slot.id}:must-skip`,
          severity: "block",
          kind: "must-skip",
          message: `${label} 标记为「需跳过」，必须安排满足约束的替代片段。`
        });
      }

      const substituteUsable = !!row.substitute && subConflicts.length === 0;
      const entry = orderMap.get(row.slot.id);
      if (!entry || !entry.source) {
        blockers.push({
          key: `${row.slot.id}:rehearsal`,
          severity: "block",
          kind: "rehearsal",
          message: `${label}：排练未记录实际放映内容。`
        });
      } else {
        const usedSubstitute = entry.source === "substitute";
        // 原片缺失：只能实际使用替代
        if (!row.primary && row.substitute && !usedSubstitute) {
          blockers.push({
            key: `${row.slot.id}:source-missing-primary`,
            severity: "block",
            kind: "source",
            message: `第${pos}位原片段已删除，排练实际放映必须选择替代「${row.substitute.code}」。`
          });
        }
        // 原片"需跳过"且已挂合规替代时，排练必须使用替代
        if (row.primary && row.primary.damage === "需跳过" && substituteUsable && !usedSubstitute) {
          blockers.push({
            key: `${row.slot.id}:source-must-skip`,
            severity: "block",
            kind: "source",
            message: `${label} 原片段需跳过，排练实际放映必须使用替代片段。`
          });
        }
        if (usedSubstitute) {
          if (!row.substitute) {
            blockers.push({
              key: `${row.slot.id}:source-no-substitute`,
              severity: "block",
              kind: "source",
              message: `${label}：排练记录选择了"替代"放映，但该位置没有可用替代片段。`
            });
          } else if (!(entry.replaceReason || "").trim()) {
            blockers.push({
              key: `${row.slot.id}:reason`,
              severity: "block",
              kind: "reason",
              message: `${label}：实际放映使用了替代片段，但未记录替换原因。`
            });
          }
        }
        const delay = Number(entry.delay) || 0;
        if (delay > 0 && !(entry.delayReason || "").trim()) {
          blockers.push({
            key: `${row.slot.id}:delay-reason`,
            severity: "block",
            kind: "delay-reason",
            message: `${label}：延误 ${delay} 秒，但未记录延误原因。`
          });
        }
      }
    });

    // 实际顺序中引用了已删除的位置
    (reel.runOrder || []).forEach((entry) => {
      if (entry && entry.slotId && !reel.slots.some((slot) => slot.id === entry.slotId)) {
        blockers.push({
          key: `${entry.slotId}:stale-order`,
          severity: "block",
          kind: "stale",
          message: `排练记录里保留了已删除排片位置的记录，需重新排练。`
        });
      }
    });

    return blockers;
  }

  /* ---------------- 提醒（原核对台的颜色/破损提醒，按卷保留） ---------------- */

  function reelWarnings(reel, library) {
    const warnings = [];
    reelSlotsWithSegments(reel, library).forEach((row, index) => {
      const seg = row.effective;
      if (!seg) return;
      const reasons = [];
      if (seg.shift !== "正常") reasons.push(seg.shift);
      if (seg.damage !== "完好") reasons.push(seg.damage);
      if (reasons.length) {
        warnings.push({
          slotId: row.slot.id,
          position: index + 1,
          code: seg.code,
          viaSubstitute: !!row.substitute,
          reasons: reasons.join(" · "),
          note: seg.note || ""
        });
      }
    });
    return warnings;
  }

  /* ---------------- 状态构造 / 迁移 ---------------- */

  function createSegment(partial) {
    partial = partial || {};
    return {
      id: partial.id || uid("seg-"),
      code: partial.code || "",
      duration: Number(partial.duration || 0),
      shift: partial.shift || "正常",
      damage: partial.damage || "完好",
      note: partial.note || "",
      thumb: partial.thumb || ""
    };
  }

  function createReel(partial) {
    partial = partial || {};
    return {
      id: uid("reel-"),
      title: partial.title || "未命名胶片卷",
      slots: partial.slots || [],
      runOrder: partial.runOrder || [],
      status: partial.status || "draft",
      finalizedAt: partial.finalizedAt || null,
      frozenLibrary: Array.isArray(partial.frozenLibrary) ? partial.frozenLibrary : null
    };
  }

  // 定版：无阻断才允许，冻结当前实际生效（含原片已删时以替代继续）的库片段快照
  function finalizeReel(reel, library) {
    if (reel.status === "finalized") return { ok: false, reel, blockers: [] };
    const blockers = reelBlockers(reel, library);
    if (blockers.length) return { ok: false, reel, blockers };
    const referenced = new Set();
    reelSlotsWithSegments(reel, library).forEach((row) => {
      if (row.primary) referenced.add(row.primary.id);
      if (row.substitute) referenced.add(row.substitute.id);
      // 原片缺失但能定版时，生效片段即替代
      if (!row.primary && row.effective) referenced.add(row.effective.id);
    });
    const snapshot = library.filter((segment) => referenced.has(segment.id)).map((segment) => JSON.parse(JSON.stringify(segment)));
    return {
      ok: true,
      reel: { ...JSON.parse(JSON.stringify(reel)), status: "finalized", finalizedAt: Date.now(), frozenLibrary: snapshot },
      blockers: []
    };
  }

  // 退回草稿：解冻，恢复为跟随共享库
  function unfinalizeReel(reel) {
    return { ...JSON.parse(JSON.stringify(reel)), status: "draft", finalizedAt: null, frozenLibrary: null };
  }

  function createSlot(segmentId) {
    return { id: uid("slot-"), segmentId, substituteId: null, substituteCancelled: false };
  }

  function seedState() {
    const lib = [
      ["LIB-001", "A-001", 18, "正常", "完好", "开场街景，节奏平稳，适合保留原顺序。"],
      ["LIB-002", "A-006", 9, "偏红", "轻微划痕", "人物近景左侧有划痕，试映时留意是否明显。"],
      ["LIB-003", "A-012", 14, "褪色", "接片松动", "接片位置靠近段尾，放映前建议重新压平。"],
      ["LIB-004", "A-018", 15, "褪色", "完好", "同批次褪色备份，色调接近 A-012，可作替代。"],
      ["LIB-005", "B-003", 12, "偏红", "完好", "红色夜景备份，色彩与划痕程度均轻于 A-006。"],
      ["LIB-006", "B-007", 20, "正常", "齿孔破损", "齿孔有伤，放映前需检查输片。"],
      ["LIB-007", "B-011", 11, "正常", "需跳过", "画面抖动严重，正式场必须跳过，用同色备份替代。"],
      ["LIB-008", "B-015", 12, "正常", "完好", "B-011 的合规替代候选，时长颜色一致。"]
    ].map(([id, code, duration, shift, damage, note]) => ({
      id,
      code,
      duration,
      shift,
      damage,
      note,
      thumb: ""
    }));

    const s1 = uid("slot-"),
      s2 = uid("slot-"),
      s3 = uid("slot-"),
      s4 = uid("slot-"),
      s5 = uid("slot-"),
      s6 = uid("slot-");

    const reelA = createReel({ title: "春日试映A卷" });
    reelA.slots = [
      { id: s1, segmentId: "LIB-001", substituteId: null, substituteCancelled: false },
      { id: s2, segmentId: "LIB-002", substituteId: null, substituteCancelled: false },
      { id: s3, segmentId: "LIB-003", substituteId: null, substituteCancelled: false }
    ];

    const reelB = createReel({ title: "春日试映B卷" });
    reelB.slots = [
      { id: s4, segmentId: "LIB-001", substituteId: null, substituteCancelled: false },
      { id: s5, segmentId: "LIB-007", substituteId: null, substituteCancelled: false },
      { id: s6, segmentId: "LIB-006", substituteId: null, substituteCancelled: false }
    ];

    return {
      schemaVersion: SCHEMA_VERSION,
      library: lib,
      reels: [reelA, reelB],
      activeReelId: reelA.id
    };
  }

  // 旧版单卷核对台数据迁移：旧片段整体入共享库，再由一卷引用
  function migrateLegacy(raw) {
    let legacy;
    try {
      legacy = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    if (!legacy || !Array.isArray(legacy.segments)) return null;
    const library = legacy.segments.map((item, index) => ({
      id: item.id && typeof item.id === "string" ? item.id : uid("seg-"),
      code: String(item.code || `旧-${index + 1}`),
      duration: Number(item.duration) || 0,
      shift: SHIFTS.includes(item.shift) ? item.shift : "正常",
      damage: DAMAGES.includes(item.damage) ? item.damage : "完好",
      note: String(item.note || ""),
      thumb: typeof item.thumb === "string" ? item.thumb : ""
    }));
    const reel = createReel({ title: legacy.reelTitle || "迁移自单卷核对台" });
    reel.slots = library.map((segment) => createSlot(segment.id));
    return {
      schemaVersion: SCHEMA_VERSION,
      library,
      reels: [reel],
      activeReelId: reel.id
    };
  }

  /* ---------------- 导入校验（异常导入要逐条说明且不破坏现有数据） ---------------- */

  /**
   * 校验并规范化导入的 JSON。
   * 返回 { ok, state, errors:[{path,message}], warnings:[{path,message}] }。
   * 有任何 error 时 ok=false，调用方必须放弃导入。
   */
  function validateProject(input) {
    const errors = [];
    const warnings = [];
    const push = (list, path, message) => list.push({ path, message });

    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return {
        ok: false,
        state: null,
        errors: [{ path: "$", message: "文件不是 JSON 对象，无法识别为排练台工程。" }],
        warnings: []
      };
    }
    if (!Array.isArray(input.library)) {
      push(errors, "library", "缺少片段库数组 library。");
    }
    if (!Array.isArray(input.reels)) {
      push(errors, "reels", "缺少胶片卷数组 reels。");
    }
    if (errors.length) return { ok: false, state: null, errors, warnings };

    const seenIds = new Set();
    const library = [];
    input.library.forEach((raw, index) => {
      const path = `library[${index}]`;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        push(errors, path, "片段必须是对象。");
        return;
      }
      if (!raw.id || typeof raw.id !== "string") {
        push(errors, `${path}.id`, "缺少片段 id。");
        return;
      }
      if (seenIds.has(raw.id)) {
        push(errors, `${path}.id`, `片段 id 重复：${raw.id}。`);
        return;
      }
      seenIds.add(raw.id);
      if (!raw.code || typeof raw.code !== "string") push(errors, `${path}.code`, "缺少片段编号 code。");
      const duration = Number(raw.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        push(errors, `${path}.duration`, `时长必须是正数秒，收到：${JSON.stringify(raw.duration)}。`);
      }
      if (!SHIFTS.includes(raw.shift)) {
        push(warnings, `${path}.shift`, `颜色偏移「${raw.shift}」不在已知列表中，已按「正常」处理。`);
      }
      if (!DAMAGES.includes(raw.damage)) {
        push(warnings, `${path}.damage`, `破损情况「${raw.damage}」不在已知列表中，已按「完好」处理。`);
      }
      if (raw.thumb && typeof raw.thumb !== "string") {
        push(warnings, `${path}.thumb`, "缩略图不是字符串，已忽略。");
      }
      library.push({
        id: raw.id,
        code: String(raw.code || ""),
        duration: Math.round(duration) || 0,
        shift: SHIFTS.includes(raw.shift) ? raw.shift : "正常",
        damage: DAMAGES.includes(raw.damage) ? raw.damage : "完好",
        note: typeof raw.note === "string" ? raw.note : "",
        thumb: typeof raw.thumb === "string" ? raw.thumb : ""
      });
    });

    const libIds = new Set(library.map((item) => item.id));
    const reelIds = new Set();
    const slotIds = new Set();
    const reels = [];

    input.reels.forEach((raw, reelIndex) => {
      const path = `reels[${reelIndex}]`;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        push(errors, path, "胶片卷必须是对象。");
        return;
      }
      if (!raw.id || typeof raw.id !== "string") {
        push(errors, `${path}.id`, "缺少胶片卷 id。");
        return;
      }
      if (reelIds.has(raw.id)) {
        push(errors, `${path}.id`, `胶片卷 id 重复：${raw.id}。`);
        return;
      }
      reelIds.add(raw.id);
      if (!raw.title || typeof raw.title !== "string") push(warnings, `${path}.title`, "胶片卷缺少标题，已命名为「未命名胶片卷」。");
      if (!Array.isArray(raw.slots)) {
        push(errors, `${path}.slots`, "胶片卷缺少 slots 排片数组。");
        return;
      }

      const slots = [];
      raw.slots.forEach((rawSlot, slotIndex) => {
        const sp = `${path}.slots[${slotIndex}]`;
        if (rawSlot === null || typeof rawSlot !== "object" || Array.isArray(rawSlot)) {
          push(errors, sp, "排片位置必须是对象。");
          return;
        }
        if (!rawSlot.id || typeof rawSlot.id !== "string") {
          push(errors, `${sp}.id`, "排片位置缺少 id。");
          return;
        }
        if (slotIds.has(rawSlot.id)) {
          push(errors, `${sp}.id`, `排片位置 id 重复：${rawSlot.id}。`);
          return;
        }
        slotIds.add(rawSlot.id);
        const primaryMissing = !libIds.has(rawSlot.segmentId);
        const substituteCancelled = !!rawSlot.substituteCancelled;
        // 取消替代后编号仅作历史记录，实际生效的是原片段，不视为可用替代候选
        const substituteUsable = !!rawSlot.substituteId && !substituteCancelled && libIds.has(rawSlot.substituteId);
        if (primaryMissing) {
          // 原片段已删：只有"未取消且在库"的替代能让该位置继续核对；否则拒绝
          if (substituteUsable) {
            push(warnings, `${sp}.segmentId`, `原片段「${rawSlot.segmentId}」已不在片段库，但已安排替代「${rawSlot.substituteId}」，该位置以替代继续。`);
          } else {
            const reason = rawSlot.substituteId && substituteCancelled ? "（替代已取消）" : "";
            push(errors, `${sp}.segmentId`, `引用的原片段「${rawSlot.segmentId}」不在片段库中，且没有可用替代片段${reason}。`);
          }
        }
        if (rawSlot.substituteId && !libIds.has(rawSlot.substituteId)) {
          push(warnings, `${sp}.substituteId`, `替代片段「${rawSlot.substituteId}」不在片段库中，已清除替代。`);
        }
        slots.push({
          id: rawSlot.id,
          segmentId: rawSlot.segmentId,
          substituteId: !!rawSlot.substituteId && libIds.has(rawSlot.substituteId) ? rawSlot.substituteId : null,
          substituteCancelled
        });
      });

      const slotIdSet = new Set(slots.map((slot) => slot.id));
      const runOrder = [];
      if (raw.runOrder != null) {
        if (!Array.isArray(raw.runOrder)) {
          push(errors, `${path}.runOrder`, "排练记录不是数组。");
        } else {
          const seenOrders = new Set();
          const seenSlots = new Set();
          raw.runOrder.forEach((entry, orderIndex) => {
            const op = `${path}.runOrder[${orderIndex}]`;
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              push(errors, op, "排练记录条目不是对象。");
              return;
            }
            if (!slotIdSet.has(entry.slotId)) {
              push(errors, `${op}.slotId`, `排练记录引用了不存在的排片位置「${entry.slotId}」。`);
              return;
            }
            if (seenSlots.has(entry.slotId)) {
              push(errors, `${op}.slotId`, `排片位置「${entry.slotId}」存在多条排练记录，每个位置只能有一条实际放映记录。`);
              return;
            }
            const order = Number(entry.order);
            if (!Number.isFinite(order) || order < 0) {
              push(errors, `${op}.order`, "排练顺序号无效。");
              return;
            }
            if (seenOrders.has(order)) {
              push(errors, `${op}.order`, `排练顺序号 ${order} 重复。`);
              return;
            }
            seenOrders.add(order);
            seenSlots.add(entry.slotId);
            const source = entry.source === "substitute" ? "substitute" : entry.source === "primary" ? "primary" : null;
            if (!source) {
              push(errors, `${op}.source`, "实际放映来源必须是 primary 或 substitute。");
              return;
            }
            runOrder.push({
              slotId: entry.slotId,
              order,
              source,
              delay: Math.max(0, Number(entry.delay) || 0),
              delayReason: typeof entry.delayReason === "string" ? entry.delayReason : "",
              replaceReason: typeof entry.replaceReason === "string" ? entry.replaceReason : ""
            });
          });
        }
      }

      let status = "draft";
      if (raw.status === "finalized") status = "finalized";
      else if (raw.status && raw.status !== "draft") {
        push(warnings, `${path}.status`, `未知状态「${raw.status}」，已按草稿处理。`);
      }

      // 定版卷必须带完整冻结快照：覆盖每个位置实际生效的片段（原片缺失时为替代）
      let frozenLibrary = null;
      if (Array.isArray(raw.frozenLibrary)) {
        frozenLibrary = raw.frozenLibrary
          .filter((s) => {
            if (!s || typeof s !== "object" || typeof s.id !== "string") return false;
            const duration = Number(s.duration);
            return Number.isFinite(duration) && duration > 0;
          })
          .map((s) => ({
            id: String(s.id),
            code: String(s.code || ""),
            duration: Number(s.duration),
            shift: SHIFTS.includes(s.shift) ? s.shift : "正常",
            damage: DAMAGES.includes(s.damage) ? s.damage : "完好",
            note: typeof s.note === "string" ? s.note : "",
            thumb: typeof s.thumb === "string" ? s.thumb : ""
          }));
      }
      if (status === "finalized") {
        if (!Array.isArray(raw.frozenLibrary)) {
          push(errors, `${path}.frozenLibrary`, "定版工程缺少冻结片段快照 frozenLibrary，不能导入为已定版卷（片段库后续改动会篡改定版内容）。");
        } else {
          const frozenIds = new Set(frozenLibrary.map((s) => s.id));
          const requiredIds = new Set();
          slots.forEach((s) => {
            // 生效片段：原片在库则算原片；只有原片缺失且替代未取消时才算替代
            if (libIds.has(s.segmentId)) {
              requiredIds.add(s.segmentId);
            } else if (s.substituteId && !s.substituteCancelled) {
              requiredIds.add(s.substituteId);
            }
          });
          const missing = [...requiredIds].filter((id) => !frozenIds.has(id));
          if (missing.length) {
            push(errors, `${path}.frozenLibrary`, `定版冻结快照缺少 ${missing.length} 个被引用片段（${missing.join("、")}），拒绝导入。`);
          }
          // 快照中的片段本身也要合法
          raw.frozenLibrary.forEach((s, i) => {
            if (!s || typeof s !== "object" || typeof s.id !== "string") return;
            if (!frozenIds.has(s.id)) return;
            const duration = Number(s.duration);
            if (!Number.isFinite(duration) || duration <= 0) {
              push(errors, `${path}.frozenLibrary[${i}].duration`, "冻结快照中存在非正时长片段。");
            }
          });

          // 定版排练记录的"实际放映来源"必须与该位置实际可用片段一致，
          // 否则导入后来源显示与实际生效片段不符（例如声明替代放映却没有替代候选）
          const slotById = new Map(slots.map((s) => [s.id, s]));
          const slotPosition = new Map(slots.map((s, i) => [s.id, i + 1]));
          runOrder.forEach((entry, i) => {
            const slot = slotById.get(entry.slotId);
            const op = `${path}.runOrder[${i}]`;
            const position = slotPosition.has(entry.slotId) ? `第${slotPosition.get(entry.slotId)}位` : "排片位置";
            if (!slot) return; // 引用不存在位置已在前面报错
            if (entry.source === "substitute") {
              if (!slot.substituteId || slot.substituteCancelled) {
                const reason = slot.substituteId && slot.substituteCancelled
                  ? `该位置的替代片段「${slot.substituteId}」已标记取消，实际生效的是原片段`
                  : "该排片位置没有安排可用替代候选";
                push(
                  errors,
                  `${op}.source`,
                  `${position}（${entry.slotId}）的定版排练记录声明本次使用替代片段放映，但${reason}，来源与实际生效片段不一致，拒绝导入。`
                );
              } else if (!frozenIds.has(slot.substituteId)) {
                push(
                  errors,
                  `${op}.source`,
                  `${position}（${entry.slotId}）的定版排练记录声明使用替代片段「${slot.substituteId}」，但该片段不在定版冻结快照中，拒绝导入。`
                );
              }
            } else if (entry.source === "primary" && !libIds.has(slot.segmentId)) {
              push(
                errors,
                `${op}.source`,
                `${position}（${entry.slotId}）的定版排练记录声明使用原片段放映，但原片段「${slot.segmentId}」已不在片段库中，应以替代来源记录，拒绝导入。`
              );
            }
          });
        }
      }
      reels.push({
        id: raw.id,
        title: typeof raw.title === "string" && raw.title ? raw.title : "未命名胶片卷",
        slots,
        runOrder,
        status,
        finalizedAt: Number.isFinite(Number(raw.finalizedAt)) ? Number(raw.finalizedAt) : null,
        frozenLibrary: status === "finalized" && frozenLibrary && frozenLibrary.length ? frozenLibrary : null
      });
    });

    const ok = errors.length === 0;
    return {
      ok,
      errors,
      warnings,
      state: ok
        ? {
            schemaVersion: SCHEMA_VERSION,
            library,
            reels,
            activeReelId: reelIds.has(input.activeReelId) ? input.activeReelId : reels[0] ? reels[0].id : null
          }
        : null
    };
  }

  function toProject(state) {
    return {
      app: "film-rehearsal-stage",
      schemaVersion: SCHEMA_VERSION,
      library: state.library,
      reels: state.reels,
      activeReelId: state.activeReelId
    };
  }

  return {
    SHIFTS,
    DAMAGES,
    DAMAGE_RANK,
    SCHEMA_VERSION,
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    HISTORY_LIMIT,
    uid,
    durationTolerance,
    formatDuration,
    segmentRisk,
    riskLevel,
    describeRisk,
    reelSlotsWithSegments,
    effectiveLibForReel,
    reelDuration,
    reelRisk,
    reelStats,
    substitutionConflicts,
    eligibleSubstitutes,
    reelBlockers,
    reelWarnings,
    createSegment,
    createReel,
    createSlot,
    finalizeReel,
    unfinalizeReel,
    seedState,
    migrateLegacy,
    validateProject,
    toProject
  };
});
