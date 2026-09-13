/*
 * 三路合并：base(共同祖先) + left/right(两个分叉页面各自的修改)
 * 原则：
 *  - 不重叠的修改自动合并；
 *  - 双方都改了同一字段且取值不同 -> 冲突，必须人工裁决，绝不静默覆盖；
 *  - 一方删除、另一方修改 -> 冲突；
 *  - 删除共享片段导致其他卷引用悬空 -> 冲突（恢复片段 / 维持删除后走阻断）；
 *  - 双方都调整了顺序且结果不一致 -> 冲突，整段顺序二选一。
 * resolutions: { [conflict.key]: 'left' | 'right' | 'delete' | 'keep' }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FilmMerge = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SEGMENT_FIELDS = ["code", "duration", "shift", "damage", "note", "thumb"];
  const REEL_FIELDS = ["title", "status", "finalizedAt"];
  const SLOT_FIELDS = ["segmentId", "substituteId", "substituteCancelled"];
  const ORDER_FIELDS = ["source", "delay", "delayReason", "replaceReason"];

  const FIELD_LABELS = {
    code: "片段编号",
    duration: "时长",
    shift: "颜色偏移",
    damage: "破损情况",
    note: "备注",
    thumb: "缩略图",
    title: "标题",
    status: "状态",
    finalizedAt: "定版时间",
    segmentId: "引用片段",
    substituteId: "替代片段",
    substituteCancelled: "取消替代",
    source: "实际放映来源",
    delay: "延误秒数",
    delayReason: "延误原因",
    replaceReason: "替换原因"
  };

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === "object") {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((key) => deepEqual(a[key], b[key]));
    }
    return false;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function label(field) {
    return FIELD_LABELS[field] || field;
  }

  // 顺序冲突以一边为锚点时，另一边独有的 id 按其自身相对顺序附在末尾；
  // 单边自动合并场景中另一边没有独有 id，锚点顺序原样保留
  function mergeOrders(baseIds, leftIds, rightIds, anchorSide) {
    const anchor = (anchorSide === "right" ? rightIds : leftIds).slice();
    const other = anchorSide === "right" ? leftIds : rightIds;
    other.forEach((id) => {
      if (!anchor.includes(id)) anchor.push(id);
    });
    return anchor;
  }

  function commonSignature(seqA, seqB, referenceIds) {
    return referenceIds.filter((id) => seqA.includes(id) && seqB.includes(id));
  }

  function normalizeReel(reel) {
    return {
      id: reel.id,
      title: reel.title || "未命名胶片卷",
      status: reel.status === "finalized" ? "finalized" : "draft",
      finalizedAt: Number.isFinite(Number(reel.finalizedAt)) ? Number(reel.finalizedAt) : null,
      slots: (reel.slots || []).map((s) => ({
        id: s.id,
        segmentId: s.segmentId,
        substituteId: s.substituteId || null,
        substituteCancelled: !!s.substituteCancelled
      })),
      runOrder: (reel.runOrder || [])
        .map((e, i) => ({
          slotId: e.slotId,
          order: Number.isFinite(Number(e.order)) ? Number(e.order) : i + 1,
          source: e.source === "substitute" ? "substitute" : "primary",
          delay: Math.max(0, Number(e.delay) || 0),
          delayReason: e.delayReason || "",
          replaceReason: e.replaceReason || ""
        }))
        .sort((a, b) => a.order - b.order),
      frozenLibrary: Array.isArray(reel.frozenLibrary) ? reel.frozenLibrary : null
    };
  }

  function mergeThreeWay(base, left, right, resolutions) {
    const chosen = Object.assign({}, resolutions || {});
    const conflicts = [];
    const addConflict = (key, kind, title, message, choices, extra) => {
      let existing = conflicts.find((c) => c.key === key);
      if (!existing) {
        existing = {
          key,
          kind,
          title,
          message,
          choices: choices.slice(),
          resolution: chosen[key] && choices.includes(chosen[key]) ? chosen[key] : null,
          ...(extra || {})
        };
        conflicts.push(existing);
      }
      return existing;
    };
    const resolutionOf = (key) => {
      const item = conflicts.find((c) => c.key === key);
      return item ? item.resolution : null;
    };

    // 标量字段合并；双方同改不同值登记冲突，未裁决时以左侧占位
    function mergeField(prefix, ownerTitle, field, baseVal, leftVal, rightVal) {
      const lChanged = !deepEqual(leftVal, baseVal);
      const rChanged = !deepEqual(rightVal, baseVal);
      if (!lChanged && !rChanged) return clone(baseVal);
      if (!lChanged) return clone(rightVal);
      if (!rChanged) return clone(leftVal);
      if (deepEqual(leftVal, rightVal)) return clone(leftVal);
      const key = `${prefix}:${field}`;
      addConflict(
        key,
        "field",
        ownerTitle,
        `「${ownerTitle}」的${label(field)}被两边改成不同值，请选择保留哪一边。`,
        ["left", "right"],
        { field, base: clone(baseVal), left: clone(leftVal), right: clone(rightVal) }
      );
      return clone(resolutionOf(key) === "right" ? rightVal : leftVal);
    }

    // 双方新建同 id 实体，字段各填各的，不同则冲突
    function mergeAddedFields(prefix, ownerTitle, fields, leftEnt, rightEnt) {
      const merged = {};
      fields.forEach((field) => {
        if (deepEqual(leftEnt[field], rightEnt[field])) {
          merged[field] = clone(leftEnt[field]);
          return;
        }
        const key = `${prefix}:${field}`;
        addConflict(
          key,
          "field",
          ownerTitle,
          `两边都新建了「${ownerTitle}」，但${label(field)}不一致，请选择。`,
          ["left", "right"],
          { field, left: clone(leftEnt[field]), right: clone(rightEnt[field]) }
        );
        merged[field] = clone(resolutionOf(key) === "right" ? rightEnt[field] : leftEnt[field]);
      });
      return merged;
    }

    /* ---------- 片段库 ---------- */

    const baseSeg = new Map((base ? base.library || [] : []).map((s) => [s.id, s]));
    const leftSeg = new Map((left ? left.library || [] : []).map((s) => [s.id, s]));
    const rightSeg = new Map((right ? right.library || [] : []).map((s) => [s.id, s]));
    const segIds = new Set([...baseSeg.keys(), ...leftSeg.keys(), ...rightSeg.keys()]);

    // 第一遍：登记删除/修改冲突
    const deletedSegmentIds = new Set();
    segIds.forEach((segId) => {
      const b = baseSeg.get(segId);
      const l = leftSeg.get(segId);
      const r = rightSeg.get(segId);
      if (b && !l && r) {
        if (!deepEqual(r, b)) {
          addConflict(
            `segment:${segId}:delete-modify`,
            "delete-modify",
            `片段 ${r.code || segId}`,
            `一边删除了片段「${r.code || segId}」，另一边修改了它。选择删除，还是保留修改后的版本？`,
            ["delete", "keep"],
            { side: "left" }
          );
        }
      } else if (b && l && !r) {
        if (!deepEqual(l, b)) {
          addConflict(
            `segment:${segId}:delete-modify`,
            "delete-modify",
            `片段 ${l.code || segId}`,
            `一边删除了片段「${l.code || segId}」，另一边修改了它。选择删除，还是保留修改后的版本？`,
            ["delete", "keep"],
            { side: "right" }
          );
        }
      }
    });

    // 第二遍：产出片段库
    let mergedLibrary = [];
    segIds.forEach((segId) => {
      const b = baseSeg.get(segId);
      const l = leftSeg.get(segId);
      const r = rightSeg.get(segId);

      if (!l && !r) return; // 两边都删了
      if (!b) {
        if (l && r) {
          mergedLibrary.push({ id: segId, ...mergeAddedFields(`segment:${segId}`, `片段 ${l.code || r.code || segId}`, SEGMENT_FIELDS, l, r) });
        } else {
          mergedLibrary.push(clone(l || r)); // 一边新增
        }
        return;
      }
      if (!l || !r) {
        const survivor = l || r;
        if (deepEqual(survivor, b)) {
          deletedSegmentIds.add(segId); // 干净删除，引用完整性稍后检查
          return;
        }
        const res = resolutionOf(`segment:${segId}:delete-modify`);
        if (res === "delete") {
          deletedSegmentIds.add(segId);
          return;
        }
        // keep 或未裁决：保留修改版本（未裁决会阻止应用）
        mergedLibrary.push(clone(survivor));
        return;
      }
      const merged = { id: segId };
      SEGMENT_FIELDS.forEach((field) => {
        merged[field] = mergeField(`segment:${segId}`, `片段 ${l.code || r.code || segId}`, field, b[field], l[field], r[field]);
      });
      mergedLibrary.push(merged);
    });

    /* ---------- 胶片卷 ---------- */

    function mergeSlot(ownerTitle, b, l, r) {
      const id = (l && l.id) || (r && r.id) || (b && b.id);
      if (!l && !r) return null;
      if (!b) {
        if (l && r) return { id, ...mergeAddedFields(`slot:${id}`, ownerTitle, SLOT_FIELDS, l, r) };
        return clone(l || r);
      }
      if (!l || !r) {
        const survivor = l || r;
        if (deepEqual(survivor, b)) return null;
        const key = `slot:${id}:delete-modify`;
        addConflict(
          key,
          "delete-modify",
          ownerTitle,
          `「${ownerTitle}」里同一个排片位置被一边删除、另一边修改。选择删除还是保留修改？`,
          ["delete", "keep"],
          { side: l ? "right" : "left" }
        );
        if (resolutionOf(key) === "delete") return null;
        return clone(survivor);
      }
      const merged = { id };
      SLOT_FIELDS.forEach((field) => {
        merged[field] = mergeField(`slot:${id}`, ownerTitle, field, b[field], l[field], r[field]);
      });
      return merged;
    }

    function mergeRunOrder(ownerTitle, bEntries, lEntries, rEntries, aliveSlotIds) {
      const alive = new Set(aliveSlotIds);
      const toMap = (list) => new Map((list || []).filter((e) => alive.has(e.slotId)).map((e) => [e.slotId, e]));
      const bMap = toMap(bEntries);
      const lMap = toMap(lEntries);
      const rMap = toMap(rEntries);
      const ids = new Set([...bMap.keys(), ...lMap.keys(), ...rMap.keys()]);
      const entries = [];

      ids.forEach((slotId) => {
        const b = bMap.get(slotId);
        const l = lMap.get(slotId);
        const r = rMap.get(slotId);
        if (!l && !r) return;
        const entry = { slotId };
        ORDER_FIELDS.forEach((field) => {
          if (l && r) {
            if (!b) {
              if (deepEqual(l[field], r[field])) entry[field] = clone(l[field]);
              else {
                const key = `runorder:${slotId}:${field}`;
                addConflict(
                  key,
                  "field",
                  ownerTitle,
                  `「${ownerTitle}」同一新排练记录的${label(field)}两边不一致，请选择。`,
                  ["left", "right"],
                  { field, left: clone(l[field]), right: clone(r[field]) }
                );
                entry[field] = clone(resolutionOf(key) === "right" ? r[field] : l[field]);
              }
            } else {
              entry[field] = mergeField(`runorder:${slotId}`, ownerTitle, field, b[field], l[field], r[field]);
            }
          } else {
            entry[field] = clone((l || r)[field]);
          }
        });
        entries.push(entry);
      });

      const baseSeq = (bEntries || []).map((e) => e.slotId).filter((id) => alive.has(id));
      const leftSeq = (lEntries || []).map((e) => e.slotId).filter((id) => alive.has(id));
      const rightSeq = (rEntries || []).map((e) => e.slotId).filter((id) => alive.has(id));
      const refIds = commonSignature(commonSignature(baseSeq, leftSeq, baseSeq), rightSeq, baseSeq);
      const leftSig = leftSeq.filter((id) => refIds.includes(id)).join(">");
      const rightSig = rightSeq.filter((id) => refIds.includes(id)).join(">");
      const baseSig = refIds.join(">");
      let anchorSide = "left";
      if (leftSig !== baseSig && rightSig !== baseSig && leftSig !== rightSig) {
        const key = `reel:${ownerTitle}:runorder-order`;
        addConflict(
          key,
          "runorder",
          ownerTitle,
          `「${ownerTitle}」两边对排练实际顺序做了不同调整，请选择以哪一边的顺序为准（另一边独有的记录附在末尾）。`,
          ["left", "right"]
        );
        anchorSide = resolutionOf(key) || "left";
      } else if (leftSig !== baseSig) {
        anchorSide = "left";
      } else if (rightSig !== baseSig) {
        anchorSide = "right";
      }
      const finalSeq = mergeOrders(baseSeq, leftSeq, rightSeq, anchorSide);
      const bySlot = new Map(entries.map((e) => [e.slotId, e]));
      return finalSeq.map((slotId, index) => ({ order: index + 1, ...(bySlot.get(slotId) || { slotId }) }));
    }

    function mergeOneReel(b, l, r) {
      const id = (l && l.id) || (r && r.id) || (b && b.id);
      if (!l && !r) return { result: null, deleted: false };
      if (!b) {
        if (l && r) {
          const ownerTitle = l.title || r.title || id;
          const head = { id, ...mergeAddedFields(`reel:${id}`, `胶片卷 ${ownerTitle}`, REEL_FIELDS, l, r) };
          return finishReel(ownerTitle, head, null, l, r, true);
        }
        return { result: normalizeReel(l || r), added: true };
      }
      if (!l || !r) {
        const survivor = l || r;
        if (deepEqual(normalizeReel(survivor), normalizeReel(b))) return { result: null, deleted: true };
        const key = `reel:${id}:delete-modify`;
        addConflict(
          key,
          "delete-modify",
          `胶片卷 ${survivor.title || id}`,
          `一边删除了胶片卷「${survivor.title || id}」，另一边仍在修改它。选择删除还是保留？`,
          ["delete", "keep"],
          { side: l ? "right" : "left" }
        );
        if (resolutionOf(key) === "delete") return { result: null, deleted: true };
        return { result: normalizeReel(survivor), updated: true };
      }

      const ownerTitle = l.title || r.title || b.title || id;
      const head = { id };
      REEL_FIELDS.forEach((field) => {
        head[field] = mergeField(`reel:${id}`, `胶片卷 ${ownerTitle}`, field, b[field], l[field], r[field]);
      });
      return finishReel(ownerTitle, head, b, l, r, false);
    }

    function finishReel(ownerTitle, head, bReel, lReel, rReel, isAdded) {
      const baseSlotsRaw = bReel ? bReel.slots : [];
      const leftSlotsRaw = lReel ? lReel.slots : [];
      const rightSlotsRaw = rReel ? rReel.slots : [];
      const baseRunOrder = bReel ? bReel.runOrder : [];
      const leftRunOrder = lReel ? lReel.runOrder : [];
      const rightRunOrder = rReel ? rReel.runOrder : [];
      const baseSlots = new Map((baseSlotsRaw || []).map((s) => [s.id, s]));
      const leftSlots = new Map((leftSlotsRaw || []).map((s) => [s.id, s]));
      const rightSlots = new Map((rightSlotsRaw || []).map((s) => [s.id, s]));
      const slotIds = new Set([...baseSlots.keys(), ...leftSlots.keys(), ...rightSlots.keys()]);
      const slotMap = new Map();
      slotIds.forEach((slotId) => {
        const merged = mergeSlot(ownerTitle, baseSlots.get(slotId), leftSlots.get(slotId), rightSlots.get(slotId));
        if (merged) slotMap.set(slotId, merged);
      });

      const baseSeq = (baseSlotsRaw || []).map((s) => s.id);
      const leftSeq = (leftSlotsRaw || []).map((s) => s.id);
      const rightSeq = (rightSlotsRaw || []).map((s) => s.id);
      const refIds = baseSeq.filter((sid) => leftSlots.has(sid) && rightSlots.has(sid));
      const leftSig = leftSeq.filter((id) => refIds.includes(id)).join(">");
      const rightSig = rightSeq.filter((id) => refIds.includes(id)).join(">");
      const baseSig = refIds.join(">");
      let anchorSide = "left";
      if (leftSig !== baseSig && rightSig !== baseSig && leftSig !== rightSig) {
        const key = `reel:${head.id}:slots-order`;
        addConflict(
          key,
          "order",
          ownerTitle,
          `「${ownerTitle}」两边对放映顺序做了不同调整，请选择以哪一边的顺序为准（另一边新加的片段附在末尾）。`,
          ["left", "right"]
        );
        anchorSide = resolutionOf(key) || "left";
      } else if (leftSig !== baseSig) {
        anchorSide = "left";
      } else if (rightSig !== baseSig) {
        anchorSide = "right";
      }
      const finalSeq = mergeOrders(baseSeq, leftSeq, rightSeq, anchorSide).filter((sid) => slotMap.has(sid));
      const mergedHead = {
        ...head,
        slots: finalSeq.map((sid) => slotMap.get(sid)),
        runOrder: mergeRunOrder(ownerTitle, baseRunOrder, leftRunOrder, rightRunOrder, finalSeq)
      };
      // 定版快照跟随定版状态：定稿沿用任一侧快照，草稿解冻
      mergedHead.frozenLibrary = mergedHead.status === "finalized" ? pickFrozen(bReel, lReel, rReel) : null;
      const reel = normalizeReel(mergedHead);
      return { result: reel, added: isAdded, updated: !isAdded };
    }

    function pickFrozen(bReel, lReel, rReel) {
      const candidate =
        (lReel && Array.isArray(lReel.frozenLibrary) && lReel.frozenLibrary) ||
        (rReel && Array.isArray(rReel.frozenLibrary) && rReel.frozenLibrary) ||
        (bReel && Array.isArray(bReel.frozenLibrary) && bReel.frozenLibrary) ||
        null;
      return candidate ? JSON.parse(JSON.stringify(candidate)) : null;
    }

    const baseReels = new Map((base ? base.reels || [] : []).map((r) => [r.id, r]));
    const leftReels = new Map((left ? left.reels || [] : []).map((r) => [r.id, r]));
    const rightReels = new Map((right ? right.reels || [] : []).map((r) => [r.id, r]));
    const reelIds = new Set([...baseReels.keys(), ...leftReels.keys(), ...rightReels.keys()]);
    let mergedReels = [];
    const stats = {
      segmentsAdded: 0,
      segmentsUpdated: 0,
      segmentsDeleted: 0,
      reelsAdded: 0,
      reelsUpdated: 0,
      reelsDeleted: 0
    };
    reelIds.forEach((reelId) => {
      const before = mergedLibrary.length;
      const outcome = mergeOneReel(baseReels.get(reelId), leftReels.get(reelId), rightReels.get(reelId));
      if (outcome.result) {
        mergedReels.push(outcome.result);
        if (outcome.added) stats.reelsAdded += 1;
        else stats.reelsUpdated += 1;
      } else if (outcome.deleted) {
        stats.reelsDeleted += 1;
      }
    });

    /* ---------- 删除片段的引用完整性 ---------- */

    const survivingIds = new Set(mergedLibrary.map((s) => s.id));
    const referenced = new Map();
    mergedReels.forEach((reel) => {
      reel.slots.forEach((slot) => {
        [slot.segmentId, slot.substituteId].forEach((ref) => {
          if (!ref) return;
          if (!referenced.has(ref)) referenced.set(ref, []);
          referenced.get(ref).push(reel.title);
        });
      });
    });

    const candidatesForDelete = new Set([...deletedSegmentIds]);
    // 未裁决的删除/修改冲突按"保留"占位，因此不在删除集合；裁决为 delete 时已加入
    deletedSegmentIds.forEach((segId) => {
      const users = referenced.get(segId);
      if (!users || !users.length) {
        stats.segmentsDeleted += 1;
        return;
      }
      const key = `segment:${segId}:reference`;
      const seg = baseSeg.get(segId) || leftSeg.get(segId) || rightSeg.get(segId);
      addConflict(
        key,
        "reference",
        `片段 ${seg ? seg.code : segId}`,
        `一边删除了共享片段「${seg ? seg.code : segId}」，但合并后仍有胶片卷（${[...new Set(users)].join("、")}）引用它。恢复该片段，还是维持删除（引用位置会成为待处理阻断）？`,
        ["keep", "delete"]
      );
      if (resolutionOf(key) === "delete") {
        stats.segmentsDeleted += 1;
      } else {
        // keep 或未裁决：恢复片段
        if (!survivingIds.has(segId)) {
          mergedLibrary.push(clone(seg));
          survivingIds.add(segId);
        }
        candidatesForDelete.delete(segId);
      }
    });

    /* ---------- 统计 ---------- */
    const baseSegIds = new Set((base ? base.library || [] : []).map((s) => s.id));
    const finalSegIds = new Set(mergedLibrary.map((s) => s.id));
    stats.segmentsAdded = [...finalSegIds].filter((id) => !baseSegIds.has(id)).length;
    stats.segmentsDeleted = [...baseSegIds].filter((id) => !finalSegIds.has(id)).length;
    stats.segmentsUpdated = mergedLibrary.filter((s) => {
      const b = baseSeg.get(s.id);
      return b && !deepEqual(b, s);
    }).length;
    stats.reelsAdded = [...mergedReels.map((r) => r.id)].filter((id) => !baseReels.has(id)).length;
    stats.reelsDeleted = [...baseReels.keys()].filter((id) => ![...mergedReels.map((r) => r.id)].includes(id)).length;
    stats.reelsUpdated = mergedReels.filter((r) => {
      const b = baseReels.get(r.id);
      return b && !deepEqual(normalizeReel(b), r);
    }).length;

    // activeReelId
    let activeReelId;
    const bActive = base ? base.activeReelId : undefined;
    const lActive = left ? left.activeReelId : undefined;
    const rActive = right ? right.activeReelId : undefined;
    if (deepEqual(lActive, bActive)) activeReelId = rActive;
    else if (deepEqual(rActive, bActive)) activeReelId = lActive;
    else activeReelId = lActive;
    if (!mergedReels.some((r) => r.id === activeReelId)) activeReelId = mergedReels[0] ? mergedReels[0].id : null;

    const state = {
      schemaVersion: 2,
      library: mergedLibrary,
      reels: mergedReels,
      activeReelId
    };
    const unresolved = conflicts.filter((c) => !c.resolution);
    return {
      state,
      conflicts,
      stats,
      resolved: unresolved.length === 0,
      unresolvedCount: unresolved.length
    };
  }

  return { mergeThreeWay, deepEqual, normalizeReel };
});
