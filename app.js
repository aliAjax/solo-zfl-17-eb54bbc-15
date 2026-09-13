/* 多卷联映排练台 —— 界面控制器 */
(function () {
  "use strict";

  const M = window.FilmModel;
  const store = window.FilmStore.createStore();

  const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

  let activeId = store.getState().activeReelId;
  let editingLibId = null;
  let subPicker = null; // {slotId, candidateId, force}
  let mergePending = null; // {kind, remote, local, base, result}
  let confirmHandler = null;

  const $ = (selector) => document.querySelector(selector);
  const els = {
    libCount: $("#libCount"),
    reelCount: $("#reelCount"),
    blockerTotal: $("#blockerTotal"),
    finalizedCount: $("#finalizedCount"),
    reelTabs: $("#reelTabs"),
    addReelBtn: $("#addReelBtn"),
    syncState: $("#syncState"),
    pauseSyncBtn: $("#pauseSyncBtn"),
    undoBtn: $("#undoBtn"),
    redoBtn: $("#redoBtn"),
    importBtn: $("#importBtn"),
    exportBtn: $("#exportBtn"),
    importFile: $("#importFile"),
    colorFilter: $("#colorFilter"),
    searchInput: $("#searchInput"),
    revisionHint: $("#revisionHint"),
    segmentForm: $("#segmentForm"),
    segmentFormTitle: $("#segmentFormTitle"),
    segmentSubmitBtn: $("#segmentSubmitBtn"),
    segmentCancelEditBtn: $("#segmentCancelEditBtn"),
    codeInput: $("#codeInput"),
    durationInput: $("#durationInput"),
    shiftInput: $("#shiftInput"),
    damageInput: $("#damageInput"),
    thumbInput: $("#thumbInput"),
    noteInput: $("#noteInput"),
    libraryList: $("#libraryList"),
    reelTitle: $("#reelTitle"),
    reelStatusBadge: $("#reelStatusBadge"),
    exportTxtBtn: $("#exportTxtBtn"),
    unfinalizeBtn: $("#unfinalizeBtn"),
    finalizeBtn: $("#finalizeBtn"),
    deleteReelBtn: $("#deleteReelBtn"),
    reelMetrics: $("#reelMetrics"),
    blockerBanner: $("#blockerBanner"),
    addSlotSelect: $("#addSlotSelect"),
    addSlotBtn: $("#addSlotBtn"),
    addSlotRow: $("#addSlotRow"),
    segmentList: $("#segmentList"),
    blockerList: $("#blockerList"),
    warningList: $("#warningList"),
    subModal: $("#subModal"),
    subModalTitle: $("#subModalTitle"),
    subModalDesc: $("#subModalDesc"),
    subCandidateList: $("#subCandidateList"),
    forceLine: $("#forceLine"),
    forceSubCheck: $("#forceSubCheck"),
    confirmSubBtn: $("#confirmSubBtn"),
    mergeModal: $("#mergeModal"),
    mergeIntro: $("#mergeIntro"),
    mergeStats: $("#mergeStats"),
    conflictList: $("#conflictList"),
    mergeRemaining: $("#mergeRemaining"),
    applyMergeBtn: $("#applyMergeBtn"),
    adoptRemoteBtn: $("#adoptRemoteBtn"),
    mergeCloseBtn: $("#mergeCloseBtn"),
    importModal: $("#importModal"),
    importModalTitle: $("#importModalTitle"),
    importResultBody: $("#importResultBody"),
    confirmModal: $("#confirmModal"),
    confirmTitle: $("#confirmTitle"),
    confirmMessage: $("#confirmMessage"),
    confirmOkBtn: $("#confirmOkBtn"),
    toastHost: $("#toastHost")
  };

  /* ---------------- 基础工具 ---------------- */

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toast(message, kind) {
    const node = document.createElement("div");
    node.className = `toast ${kind || ""}`;
    node.textContent = message;
    els.toastHost.appendChild(node);
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transition = "opacity .3s";
      setTimeout(() => node.remove(), 320);
    }, 3200);
  }

  function state() {
    return store.getState();
  }

  function libById() {
    return new Map(state().library.map((item) => [item.id, item]));
  }

  function activeReel() {
    const s = state();
    return s.reels.find((reel) => reel.id === activeId) || s.reels[0] || null;
  }

  function commit(nextState, meta) {
    const result = store.commit(nextState, meta);
    if (result.status === "conflict") {
      openMerge({ ...result, kind: "commit" });
    } else if (result.autoMerged) {
      toast("已自动合并另一页面的修改，无冲突。", "success");
    }
    renderAll();
    return result;
  }

  function mutateActiveReel(mutator, meta) {
    const next = JSON.parse(JSON.stringify(state()));
    const reel = next.reels.find((item) => item.id === activeId);
    if (!reel) return { status: "noop" };
    mutator(reel, next);
    return commit(next, meta);
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function askConfirm(title, message, onOk, okLabel) {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOkBtn.textContent = okLabel || "确认";
    confirmHandler = onOk;
    els.confirmModal.hidden = false;
  }

  /* ---------------- 渲染：顶部 / 卷标签 ---------------- */

  function blockersByReel() {
    const s = state();
    const map = new Map();
    s.reels.forEach((reel) => map.set(reel.id, reel.status === "finalized" ? [] : M.reelBlockers(reel, s.library)));
    return map;
  }

  function renderChrome() {
    const s = state();
    els.libCount.textContent = s.library.length;
    els.reelCount.textContent = s.reels.length;
    const blockerMap = blockersByReel();
    let totalBlockers = 0;
    blockerMap.forEach((list) => (totalBlockers += list.length));
    els.blockerTotal.textContent = totalBlockers;
    els.finalizedCount.textContent = s.reels.filter((r) => r.status === "finalized").length;
    els.revisionHint.textContent = `版本 #${store.getRevision()}${store.isPaused() ? " · 分叉排练中" : ""}`;

    els.reelTabs.innerHTML = s.reels
      .map((reel) => {
        const count = blockerMap.get(reel.id)?.length || 0;
        return `
          <button type="button" class="reel-tab ${reel.id === activeId ? "active" : ""}" data-reel-id="${reel.id}">
            ${escapeHtml(reel.title || "未命名胶片卷")}
            ${reel.status === "finalized" ? '<span class="tab-seal">已定版</span>' : ""}
            ${count > 0 ? `<span class="tab-flag">${count} 阻断</span>` : ""}
          </button>`;
      })
      .join("");

    const paused = store.isPaused();
    els.syncState.textContent = paused ? "分叉排练中（暂停同步）" : "实时同步";
    els.syncState.className = `sync-state ${paused ? "paused" : ""}`;
    els.pauseSyncBtn.textContent = paused ? "恢复同步并合并" : "暂停同步（分叉排练）";
    els.undoBtn.disabled = !store.canUndo();
    els.redoBtn.disabled = !store.canRedo();
  }

  /* ---------------- 渲染：共享片段库 ---------------- */

  function filters() {
    return { color: els.colorFilter.value, keyword: els.searchInput.value.trim() };
  }

  function segmentMatchesFilter(segment) {
    const { color, keyword } = filters();
    const matchesColor = color === "all" || segment.shift === color;
    const matchesKeyword = !keyword || `${segment.code}${segment.note}${segment.damage}`.includes(keyword);
    return matchesColor && matchesKeyword;
  }

  function renderLibrary() {
    const s = state();
    const refs = new Map();
    s.reels.forEach((reel) => {
      reel.slots.forEach((slot) => {
        [slot.segmentId, slot.substituteId].forEach((id) => {
          if (!id) return;
          if (!refs.has(id)) refs.set(id, new Set());
          refs.get(id).add(reel.title || "未命名胶片卷");
        });
      });
    });

    const visible = s.library.filter(segmentMatchesFilter);
    els.libraryList.innerHTML =
      visible
        .map((item) => {
          const users = [...(refs.get(item.id) || [])];
          const damaged = item.damage !== "完好";
          return `
          <article class="library-card" data-lib-id="${item.id}">
            <div>
              <div class="lib-title">
                <span class="lib-code">${escapeHtml(item.code)}</span>
                <span class="tag">${escapeHtml(item.shift)}</span>
                <span class="tag ${damaged ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
                <span class="segment-meta">${M.formatDuration(item.duration)}</span>
              </div>
              <p class="lib-note">${escapeHtml(item.note || "没有备注。")}</p>
              <div class="lib-refs">${users.length ? `被 ${users.length} 卷引用：${users.map(escapeHtml).join("、")}（修改会同步）` : "暂无卷引用"}</div>
            </div>
            <div class="lib-actions">
              <button type="button" data-lib-edit="${item.id}">编辑</button>
              <button type="button" class="danger" data-lib-delete="${item.id}">删除</button>
            </div>
          </article>`;
        })
        .join("") || `<p class="empty">没有符合筛选的共享片段。</p>`;

    // 加入本卷下拉
    const reel = activeReel();
    const usedPrimaries = new Set((reel ? reel.slots : []).map((slot) => slot.segmentId));
    els.addSlotSelect.innerHTML = s.library
      .map((item) => `<option value="${item.id}" ${usedPrimaries.has(item.id) ? "disabled" : ""}>${escapeHtml(item.code)}｜${M.formatDuration(item.duration)}｜${escapeHtml(item.shift)}｜${escapeHtml(item.damage)}${usedPrimaries.has(item.id) ? "（已在本卷）" : ""}</option>`)
      .join("");
  }

  /* ---------------- 渲染：当前卷 ---------------- */

  function renderReel() {
    const s = state();
    const reel = activeReel();
    if (!reel) {
      els.reelTitle.value = "";
      els.reelTitle.disabled = true;
      els.reelStatusBadge.textContent = "无卷";
      els.reelStatusBadge.className = "status-badge draft";
      els.segmentList.innerHTML = `<p class="empty">还没有胶片卷，点击上方「新建卷」开始。</p>`;
      els.reelMetrics.innerHTML = "";
      els.blockerList.innerHTML = "";
      els.warningList.innerHTML = "";
      els.blockerBanner.hidden = true;
      [els.finalizeBtn, els.deleteReelBtn, els.exportTxtBtn, els.addSlotBtn].forEach((b) => (b.disabled = true));
      els.unfinalizeBtn.hidden = true;
      els.addSlotRow.style.opacity = "0.5";
      els.addSlotSelect.disabled = true;
      return;
    }
    [els.finalizeBtn, els.deleteReelBtn, els.exportTxtBtn, els.addSlotBtn].forEach((b) => (b.disabled = false));
    els.addSlotRow.style.opacity = "1";

    const readonly = reel.status === "finalized";
    els.reelTitle.value = reel.title || "";
    els.reelTitle.disabled = readonly;
    els.reelStatusBadge.textContent = readonly ? "已定版（只读）" : "草稿";
    els.reelStatusBadge.className = `status-badge ${readonly ? "finalized" : "draft"}`;
    els.unfinalizeBtn.hidden = !readonly;
    els.finalizeBtn.hidden = readonly;
    els.finalizeBtn.textContent = "核对定版";
    els.addSlotSelect.disabled = readonly;

    const stats = M.reelStats(reel, s.library);
    const risk = M.riskLevel(stats.risk);
    const totalDelay = (reel.runOrder || []).reduce((sum, e) => sum + (Number(e.delay) || 0), 0);
    els.reelMetrics.innerHTML = `
      <div class="metric"><span>总时长（含替代）</span><strong>${M.formatDuration(stats.duration)}</strong></div>
      <div class="metric"><span>风险</span><strong class="risk-${risk.level}">${risk.label} · ${stats.risk}</strong></div>
      <div class="metric"><span>破损片段 / 排片</span><strong>${stats.damageCount} / ${stats.slotCount}</strong></div>
      <div class="metric"><span>排练累计延误</span><strong>${M.formatDuration(totalDelay)}</strong></div>
    `;

    const rows = M.reelSlotsWithSegments(reel, s.library);
    const orderMap = new Map((reel.runOrder || []).map((e) => [e.slotId, e]));
    const visibleIndexes = [];

    els.segmentList.innerHTML = rows
      .map((row, index) => {
        const pos = index + 1;
        if (row.effective && !segmentMatchesFilter(row.effective)) return "";
        visibleIndexes.push(index);
        const { slot, primary, substitute, effective } = row;
        const entry = orderMap.get(slot.id) || null;
        const disabled = readonly ? "disabled" : "";
        const conflicts = primary && substitute ? M.substitutionConflicts(primary, substitute) : [];
        const subBad = conflicts.length > 0;

        const thumb = effective
          ? effective.thumb
            ? `<img src="${effective.thumb}" alt="${escapeHtml(effective.code)}缩略图" />`
            : `<div class="film-placeholder" style="background:${fallbackThumbs[index % fallbackThumbs.length]}">${escapeHtml(effective.code)}</div>`
          : `<div class="film-placeholder" style="background:#5a2a2a">片段缺失</div>`;

        const primaryLine = primary
          ? `<strong>${pos}. ${escapeHtml(primary.code)}</strong>
             <span class="segment-meta">${M.formatDuration(primary.duration)}</span>
             <span class="tag">${escapeHtml(primary.shift)}</span>
             <span class="tag ${primary.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(primary.damage)}</span>`
          : `<strong>${pos}. 原片段缺失</strong><span class="conflict-chip">引用悬空</span>`;

        const subSection = substitute
          ? `<div class="sub-line ${subBad ? "bad" : ""}">
               <span class="sub-pill">${subBad ? "冲突替代" : "已安排替代"}</span>
               <strong>${escapeHtml(substitute.code)}</strong>
               <span class="segment-meta">${M.formatDuration(substitute.duration)}｜${escapeHtml(substitute.shift)}｜${escapeHtml(substitute.damage)}</span>
               ${subBad ? `<span class="conflict-chips">${conflicts.map((c) => `<span class="conflict-chip" title="${escapeHtml(c.message)}">${escapeHtml(c.message.split("：")[0])}</span>`).join("")}</span>` : '<span class="empty-ok">满足全部约束</span>'}
               ${readonly ? "" : `<button type="button" class="small" data-sub-cancel="${slot.id}">取消替代</button>`}
             </div>
             ${subBad ? `<ul class="conflict-detail">${conflicts.map((c) => `<li>${escapeHtml(c.message)}</li>`).join("")}</ul>` : ""}`
          : "";

        const actions = readonly
          ? ""
          : `<div class="segment-actions">
               <button type="button" title="上移" data-move-up="${slot.id}" ${index === 0 ? "disabled" : ""}>↑</button>
               <button type="button" title="下移" data-move-down="${slot.id}" ${index === rows.length - 1 ? "disabled" : ""}>↓</button>
               <button type="button" title="安排替代" data-sub="${slot.id}">替</button>
               <button type="button" title="删除出本卷" class="danger" data-remove-slot="${slot.id}">×</button>
             </div>`;

        const sourceVal = entry ? entry.source : substitute ? "substitute" : "primary";
        const primaryOptionDisabled = !primary ? "disabled" : "";
        const rehearsal = `
          <div class="rehearsal-box ${entry ? "" : "unrecorded"}">
            <label>实际顺序
              <input type="number" min="1" step="1" value="${entry ? entry.order : ""}" placeholder="${pos}" data-run="${slot.id}" data-field="order" ${disabled} />
            </label>
            <label>实际放映
              <select data-run="${slot.id}" data-field="source" ${disabled}>
                <option value="primary" ${sourceVal === "primary" ? "selected" : ""} ${primaryOptionDisabled}>原片段${primary ? "·" + escapeHtml(primary.code) : "（已删除，不可用）"}</option>
                <option value="substitute" ${sourceVal === "substitute" ? "selected" : ""} ${substitute ? "" : "disabled"}>替代${substitute ? "·" + escapeHtml(substitute.code) : ""}</option>
              </select>
            </label>
            <label>延误秒数 / 原因
              <input type="number" min="0" step="1" value="${entry ? entry.delay : ""}" placeholder="0" data-run="${slot.id}" data-field="delay" ${disabled} />
              <input type="text" value="${escapeHtml(entry ? entry.delayReason : "")}" placeholder="有延误时必须填写原因" data-run="${slot.id}" data-field="delayReason" ${disabled} />
            </label>
            <label>替换原因
              <input type="text" value="${escapeHtml(entry ? entry.replaceReason : "")}" placeholder="${substitute ? "使用替代必须填写原因" : "未使用替代"}" data-run="${slot.id}" data-field="replaceReason" ${disabled} />
            </label>
          </div>`;

        return `
          <article class="segment-card ${substitute ? "has-sub" : ""} ${!primary ? "missing" : ""} ${readonly ? "finalized-card" : ""}"
                   draggable="${readonly ? "false" : "true"}" data-slot-id="${slot.id}">
            <div class="thumb">${thumb}</div>
            <div class="segment-main">
              <div class="segment-title">${primaryLine}</div>
              <p class="segment-note">${escapeHtml(effective ? effective.note || "没有备注。" : "请从片段库安排替代或移除该位置。")}</p>
              ${subSection}
              ${rehearsal}
            </div>
            ${actions}
          </article>`;
      })
      .join("") || `<p class="empty">没有符合筛选的排片位置。</p>`;

    renderBlockersAndWarnings(reel);
  }

  function renderBlockersAndWarnings(reel) {
    const s = state();
    const blockers = reel.status === "finalized" ? [] : M.reelBlockers(reel, s.library);
    els.blockerList.innerHTML = blockers.length
      ? blockers
          .map(
            (b) => `
        <div class="blocker-item">
          <span class="kind">${escapeHtml(kindLabel(b.kind))}</span>${escapeHtml(b.message)}
        </div>`
          )
          .join("")
      : reel.status === "finalized"
        ? '<p class="empty-ok">已定版，全部阻断已处理，数据只读。</p>'
        : '<p class="empty-ok">当前没有阻断，可以定版。</p>';

    els.blockerBanner.hidden = blockers.length === 0;
    if (blockers.length) {
      els.blockerBanner.textContent = `本卷还有 ${blockers.length} 项未处理阻断，不能定版。请逐条处理：冲突替代、未排练、缺原因或需跳过项。`;
    }

    const warnings = M.reelWarnings(reel, s.library);
    els.warningList.innerHTML = warnings.length
      ? warnings
          .map((w) => {
            const detail = w.reasons + (w.note ? `：${w.note}` : "");
            return `
          <div class="warning-item">
            <strong>${w.position}. ${escapeHtml(w.code)}${w.viaSubstitute ? "（替代生效）" : ""}</strong>
            <span>${escapeHtml(detail)}</span>
          </div>`;
          })
          .join("")
      : `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
  }

  function kindLabel(kind) {
    return (
      {
        missing: "引用缺失",
        conflict: "替代冲突",
        "must-skip": "需跳过",
        rehearsal: "未排练",
        reason: "缺替换原因",
        "delay-reason": "缺延误原因",
        stale: "记录失效",
        source: "来源矛盾"
      }[kind] || "阻断"
    );
  }

  function renderAll() {
    if (!activeId || !state().reels.some((r) => r.id === activeId)) {
      activeId = state().reels[0] ? state().reels[0].id : null;
    }
    renderChrome();
    renderLibrary();
    renderReel();
  }

  /* ---------------- 片段库操作 ---------------- */

  els.segmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
    const payload = {
      code: els.codeInput.value.trim(),
      duration: Number(els.durationInput.value),
      shift: els.shiftInput.value,
      damage: els.damageInput.value,
      note: els.noteInput.value.trim(),
      thumb: thumb || (editingLibId ? state().library.find((s) => s.id === editingLibId)?.thumb || "" : "")
    };
    const next = JSON.parse(JSON.stringify(state()));
    const wasEditing = !!editingLibId;
    if (editingLibId) {
      const target = next.library.find((item) => item.id === editingLibId);
      if (target) Object.assign(target, payload);
      toast("共享片段已修改，所有引用它的卷已同步重算时长与风险。", "success");
    } else {
      next.library.push(M.createSegment(payload));
    }
    editingLibId = null;
    resetSegmentForm();
    commit(next, { kind: wasEditing ? "library-update" : "library-add" });
  });

  els.segmentCancelEditBtn.addEventListener("click", () => {
    editingLibId = null;
    resetSegmentForm();
  });

  function resetSegmentForm() {
    els.segmentForm.reset();
    els.durationInput.value = 12;
    els.segmentFormTitle.textContent = "录入新片段";
    els.segmentSubmitBtn.textContent = "加入片段库";
    els.segmentCancelEditBtn.hidden = true;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  els.libraryList.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-lib-edit]");
    const deleteBtn = event.target.closest("[data-lib-delete]");
    if (editBtn) {
      const id = editBtn.dataset.libEdit;
      const seg = state().library.find((item) => item.id === id);
      if (!seg) return;
      editingLibId = id;
      els.codeInput.value = seg.code;
      els.durationInput.value = seg.duration;
      els.shiftInput.value = seg.shift;
      els.damageInput.value = seg.damage;
      els.noteInput.value = seg.note || "";
      els.segmentFormTitle.textContent = `编辑共享片段 ${seg.code}（同步所有引用卷）`;
      els.segmentSubmitBtn.textContent = "保存修改";
      els.segmentCancelEditBtn.hidden = false;
      els.segmentForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (deleteBtn) {
      const id = deleteBtn.dataset.libDelete;
      const seg = state().library.find((item) => item.id === id);
      if (!seg) return;
      const users = new Set();
      state().reels.forEach((reel) => reel.slots.forEach((slot) => {
        if (slot.segmentId === id || slot.substituteId === id) users.add(reel.title);
      }));
      const msg = users.size
        ? `片段「${seg.code}」仍被 ${[...users].join("、")} 引用。删除后这些位置会变成待处理阻断；若另一个页面正在修改它，合并时还需人工裁决。确认删除？`
        : `确认从共享片段库删除「${seg.code}」？`;
      askConfirm("删除共享片段", msg, () => {
        const next = JSON.parse(JSON.stringify(state()));
        next.library = next.library.filter((item) => item.id !== id);
        commit(next, { kind: "library-delete" });
      }, "删除");
    }
  });

  /* ---------------- 卷与排片操作 ---------------- */

  els.addReelBtn.addEventListener("click", () => {
    const next = JSON.parse(JSON.stringify(state()));
    const reel = M.createReel({ title: `联映卷 ${String.fromCharCode(65 + next.reels.length)}` });
    next.reels.push(reel);
    next.activeReelId = reel.id;
    activeId = reel.id;
    commit(next, { kind: "reel-add" });
  });

  els.reelTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-reel-id]");
    if (!tab) return;
    activeId = tab.dataset.reelId;
    const result = store.setActiveReel(activeId);
    if (result && result.status === "conflict") {
      openMerge({ ...result, kind: "commit" });
    } else if (result && result.autoMerged) {
      toast("切换时发现另一页面的新版本，已自动合并，对方修改未丢失。", "success");
    }
    renderAll();
  });

  els.reelTitle.addEventListener("change", () => {
    mutateActiveReel((reel) => {
      reel.title = els.reelTitle.value.trim() || "未命名胶片卷";
    }, { kind: "reel-rename" });
  });

  els.deleteReelBtn.addEventListener("click", () => {
    const reel = activeReel();
    if (!reel) return;
    askConfirm("删除胶片卷", `确认删除整卷「${reel.title}」？其排练记录一并删除，共享片段库不受影响。`, () => {
      const next = JSON.parse(JSON.stringify(state()));
      next.reels = next.reels.filter((item) => item.id !== reel.id);
      activeId = next.reels[0] ? next.reels[0].id : null;
      commit(next, { kind: "reel-delete" });
    }, "删除整卷");
  });

  els.addSlotBtn.addEventListener("click", () => {
    const segmentId = els.addSlotSelect.value;
    if (!segmentId) return;
    const reel = activeReel();
    if (reel.status === "finalized") return;
    mutateActiveReel((r) => {
      r.slots.push(M.createSlot(segmentId));
    }, { kind: "slot-add" });
  });

  els.segmentList.addEventListener("click", (event) => {
    const reel = activeReel();
    if (!reel || reel.status === "finalized") return;
    const up = event.target.closest("[data-move-up]");
    const down = event.target.closest("[data-move-down]");
    const subBtn = event.target.closest("[data-sub]");
    const cancelSub = event.target.closest("[data-sub-cancel]");
    const remove = event.target.closest("[data-remove-slot]");

    if (up || down) {
      const slotId = up ? up.dataset.moveUp : down.dataset.moveDown;
      const delta = up ? -1 : 1;
      mutateActiveReel((r) => {
        const index = r.slots.findIndex((s) => s.id === slotId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= r.slots.length) return;
        const [item] = r.slots.splice(index, 1);
        r.slots.splice(target, 0, item);
      }, { kind: "slot-move" });
    }
    if (subBtn) openSubPicker(subBtn.dataset.sub);
    if (cancelSub) {
      mutateActiveReel((r) => {
        const slot = r.slots.find((s) => s.id === cancelSub.dataset.subCancel);
        if (slot) {
          slot.substituteId = null;
          slot.substituteCancelled = true;
        }
      }, { kind: "sub-cancel" });
    }
    if (remove) {
      const slotId = remove.dataset.removeSlot;
      mutateActiveReel((r) => {
        r.slots = r.slots.filter((s) => s.id !== slotId);
        r.runOrder = r.runOrder.filter((e) => e.slotId !== slotId);
      }, { kind: "slot-remove" });
    }
  });

  // 排练记录：change 时提交，避免输入中重绘丢焦点
  els.segmentList.addEventListener("change", (event) => {
    const input = event.target.closest("[data-run]");
    if (!input) return;
    const reel = activeReel();
    if (!reel || reel.status === "finalized") return;
    const slotId = input.dataset.run;
    const field = input.dataset.field;
    const raw = input.value;
    mutateActiveReel((r) => {
      let entry = r.runOrder.find((e) => e.slotId === slotId);
      if (!entry) {
        const planIndex = r.slots.findIndex((s) => s.id === slotId);
        const slot = r.slots[planIndex];
        // 默认来源与表单展示一致：已安排（未取消）替代时默认替代，否则原片
        const defaultSource = slot && slot.substituteId && !slot.substituteCancelled ? "substitute" : "primary";
        entry = { slotId, order: planIndex + 1, source: defaultSource, delay: 0, delayReason: "", replaceReason: "" };
        r.runOrder.push(entry);
      }
      if (field === "order") entry.order = Math.max(1, Number(raw) || entry.order);
      else if (field === "delay") entry.delay = Math.max(0, Number(raw) || 0);
      else if (field === "source") entry.source = raw === "substitute" ? "substitute" : "primary";
      else entry[field] = raw;
    }, { kind: "runorder" });
  });

  /* ---------------- 拖拽（计划顺序） ---------------- */

  let draggedSlotId = null;
  els.segmentList.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-slot-id]");
    if (!card) return;
    draggedSlotId = card.dataset.slotId;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  els.segmentList.addEventListener("dragend", () => {
    document.querySelectorAll(".segment-card.dragging,.segment-card.drag-over").forEach((n) => n.classList.remove("dragging", "drag-over"));
    draggedSlotId = null;
  });
  els.segmentList.addEventListener("dragover", (event) => {
    const card = event.target.closest("[data-slot-id]");
    if (!card || !draggedSlotId || card.dataset.slotId === draggedSlotId) return;
    event.preventDefault();
    document.querySelectorAll(".segment-card.drag-over").forEach((n) => n.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });
  els.segmentList.addEventListener("drop", (event) => {
    const card = event.target.closest("[data-slot-id]");
    if (!card || !draggedSlotId || card.dataset.slotId === draggedSlotId) return;
    event.preventDefault();
    const targetId = card.dataset.slotId;
    mutateActiveReel((r) => {
      const from = r.slots.findIndex((s) => s.id === draggedSlotId);
      const to = r.slots.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return;
      const [item] = r.slots.splice(from, 1);
      r.slots.splice(to, 0, item);
    }, { kind: "slot-drag" });
  });

  /* ---------------- 替代片段选择 ---------------- */

  function openSubPicker(slotId) {
    const reel = activeReel();
    const row = M.reelSlotsWithSegments(reel, state().library).find((r) => r.slot.id === slotId);
    if (!row) return;
    if (!row.primary && row.substitute) {
      toast("该位置原片段已删除，当前以替代继续；可先取消替代再重新安排。", "warn");
      return;
    }
    subPicker = { slotId, candidateId: null, force: false, missingPrimary: !row.primary };
    if (!row.primary) {
      // 原片段已删除：无法比对颜色/破损/时长约束，所有库片段均可作为继承替代，由用户自行核对
      els.subModalTitle.textContent = `第 ${reel.slots.findIndex((s) => s.id === slotId) + 1} 位原片段已删除 — 安排替代继续核对`;
      els.subModalDesc.innerHTML = `原片段不在片段库中，<strong>无法自动校验颜色、破损与时长约束</strong>，请自行挑选画面/时长合适的片段；该位置排练时必须实际使用替代并填写替换原因。`;
      els.subCandidateList.innerHTML = state()
        .library.filter((s) => s.id !== row.substitute?.id)
        .map((c) => {
          return `
        <label class="candidate-card" data-candidate="${c.id}">
          <div>
            <div class="cand-head">
              <strong>${escapeHtml(c.code)}</strong>
              <span class="segment-meta">${M.formatDuration(c.duration)}｜${escapeHtml(c.shift)}｜${escapeHtml(c.damage)}</span>
            </div>
            <p class="cand-ok">原片段缺失，约束需人工核对。</p>
          </div>
          <input type="radio" name="subCandidate" value="${c.id}" />
        </label>`;
        })
        .join("");
    } else {
      const tolerance = M.durationTolerance(row.primary.duration);
      els.subModalTitle.textContent = `为「${row.primary.code}」安排替代片段`;
      els.subModalDesc.innerHTML = `约束：颜色必须一致（${escapeHtml(row.primary.shift)}）、破损不能更严重（当前 ${escapeHtml(row.primary.damage)}）、时长容差 ±${tolerance} 秒（${M.formatDuration(row.primary.duration)}）。不满足的候选会<strong>逐条列出冲突</strong>，强制安排将保持阻断直到处理。`;
      const candidates = M.eligibleSubstitutes(row.primary, state().library);
      els.subCandidateList.innerHTML = candidates
        .map((c) => {
          const bad = c.conflicts.length > 0;
          return `
        <label class="candidate-card ${bad ? "has-conflicts" : ""}" data-candidate="${c.segment.id}">
          <div>
            <div class="cand-head">
              <strong>${escapeHtml(c.segment.code)}</strong>
              <span class="segment-meta">${M.formatDuration(c.segment.duration)}｜${escapeHtml(c.segment.shift)}｜${escapeHtml(c.segment.damage)}</span>
            </div>
            ${bad ? `<ul>${c.conflicts.map((x) => `<li>${escapeHtml(x.message)}</li>`).join("")}</ul>` : '<p class="cand-ok">满足颜色、破损与时长全部约束。</p>'}
          </div>
          <input type="radio" name="subCandidate" value="${c.segment.id}" />
        </label>`;
        })
        .join("");
    }
    els.forceLine.hidden = true;
    els.forceSubCheck.checked = false;
    els.confirmSubBtn.disabled = true;
    els.subModal.hidden = false;
  }

  els.subCandidateList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-candidate]");
    if (!card) return;
    const id = card.dataset.candidate;
    subPicker.candidateId = id;
    document.querySelectorAll(".candidate-card").forEach((n) => n.classList.toggle("selected", n.dataset.candidate === id));
    const reel = activeReel();
    const row = M.reelSlotsWithSegments(reel, state().library).find((r) => r.slot.id === subPicker.slotId);
    const candidate = state().library.find((s) => s.id === id);
    if (!row.primary) {
      // 原片缺失：不自动校验约束，用户选择后即可确认
      els.forceLine.hidden = true;
      els.forceSubCheck.checked = false;
      subPicker.force = false;
      els.confirmSubBtn.disabled = false;
      els.confirmSubBtn.textContent = "确认安排替代";
      return;
    }
    const conflicts = M.substitutionConflicts(row.primary, candidate);
    const bad = conflicts.length > 0;
    els.forceLine.hidden = !bad;
    els.forceSubCheck.checked = false;
    subPicker.force = false;
    els.confirmSubBtn.disabled = bad;
    els.confirmSubBtn.textContent = bad ? "勾选强制后才能安排" : "确认安排替代";
  });

  els.forceSubCheck.addEventListener("change", () => {
    subPicker.force = els.forceSubCheck.checked;
    els.confirmSubBtn.disabled = !subPicker.force;
    els.confirmSubBtn.textContent = "强制安排（保留阻断）";
  });

  els.confirmSubBtn.addEventListener("click", () => {
    if (!subPicker || !subPicker.candidateId) return;
    const reel = activeReel();
    const row = M.reelSlotsWithSegments(reel, state().library).find((r) => r.slot.id === subPicker.slotId);
    const candidate = state().library.find((s) => s.id === subPicker.candidateId);
    const conflicts = row.primary ? M.substitutionConflicts(row.primary, candidate) : [];
    if (conflicts.length && !subPicker.force) {
      toast("该候选存在冲突，必须逐条知悉并勾选强制安排。", "error");
      return;
    }
    mutateActiveReel((r) => {
      const slot = r.slots.find((s) => s.id === subPicker.slotId);
      slot.substituteId = subPicker.candidateId;
      slot.substituteCancelled = false;
    }, { kind: "sub-set" });
    els.subModal.hidden = true;
    if (conflicts.length) {
      toast(`已强制安排冲突替代，${conflicts.length} 项冲突保持阻断，定版前必须处理。`, "warn");
    } else if (!row.primary) {
      toast("替代已安排，该位置以替代继续，排练时须实际使用替代并填写替换原因。", "success");
    } else {
      toast("替代片段已安排，时长与风险已重算。", "success");
    }
  });

  /* ---------------- 定版 ---------------- */

  els.finalizeBtn.addEventListener("click", () => {
    const reel = activeReel();
    const s = state();
    const blockers = M.reelBlockers(reel, s.library);
    if (blockers.length) {
      toast(`还有 ${blockers.length} 项未处理阻断，不能定版。`, "error");
      return;
    }
    const done = M.finalizeReel(reel, s.library);
    if (!done.ok) return;
    const next = JSON.parse(JSON.stringify(s));
    const target = next.reels.find((r) => r.id === reel.id);
    Object.assign(target, done.reel);
    commit(next, { kind: "finalize" });
    if (target.status === "finalized") toast("已定版：数据只读，并冻结片段快照，不再跟随共享库变化。", "success");
  });

  els.unfinalizeBtn.addEventListener("click", () => {
    askConfirm("退回草稿", "退回后本卷恢复可编辑，并重新跟随共享片段库的最新内容，需要再次核对定版。", () => {
      const next = JSON.parse(JSON.stringify(state()));
      const reel = next.reels.find((r) => r.id === activeId);
      Object.assign(reel, M.unfinalizeReel(reel));
      commit(next, { kind: "unfinalize" });
    }, "退回草稿");
  });

  /* ---------------- 分叉合并人工裁决 ---------------- */

  function openMerge(pending) {
    mergePending = pending;
    const introKinds = {
      commit: "你提交修改时，另一个页面已经写入了新版本。系统已自动合并不冲突的修改；以下条目两边改动互相矛盾，<strong>必须逐条选择，不能静默覆盖</strong>。",
      incoming: "另一个页面写入了与本页矛盾的修改。系统已自动合并不冲突的部分；以下冲突<strong>必须逐条人工裁决</strong>。",
      resume: "恢复同步时发现：分叉排练期间另一页面改动了同一内容。以下冲突<strong>必须逐条裁决</strong>后才能合并。",
      undo: "撤销时发现另一页面已经写入新版本，撤销目标与对方修改冲突，需要逐条裁决。"
    };
    els.mergeIntro.innerHTML = introKinds[pending.kind] || introKinds.commit;
    const st = pending.result.stats;
    if (st) {
      els.mergeStats.textContent = `自动合并：片段 +${st.segmentsAdded}/-${st.segmentsDeleted}，改 ${st.segmentsUpdated}；胶片卷 +${st.reelsAdded}/-${st.reelsDeleted}，改 ${st.reelsUpdated}。待裁决冲突 ${pending.result.conflicts.length} 条。`;
    }
    renderConflictList({});
    els.mergeModal.hidden = false;
  }

  function renderConflictList(resolutions) {
    const conflicts = mergePending.result.conflicts;
    els.conflictList.innerHTML = conflicts
      .map((c, index) => {
        const picked = resolutions[c.key] || c.resolution;
        const labels = {
          left: "对方版本",
          right: "本页版本",
          delete: "删除",
          keep: "保留"
        };
        const choices = c.choices
          .map((choice) => {
            let preview = "";
            if (c.kind === "field") {
              const val = choice === "left" ? c.left : c.right;
              preview = previewValue(c.field, val);
            }
            return `
            <button type="button" class="choice-btn ${picked === choice ? "picked" : ""}" data-conflict-index="${index}" data-choice="${choice}">
              <span class="choice-label">${labels[choice] || choice}</span>
              ${preview}
            </button>`;
          })
          .join("");
        return `
        <div class="conflict-item ${picked ? "resolved" : ""}">
          <div class="conflict-kind">${escapeHtml(conflictKindLabel(c.kind))} · ${escapeHtml(c.title || "")}</div>
          <div class="conflict-msg">${escapeHtml(c.message)}</div>
          <div class="choice-row">${choices}</div>
        </div>`;
      })
      .join("");
    const remaining = conflicts.filter((c) => !resolutions[c.key] && !c.resolution).length;
    els.mergeRemaining.textContent = remaining ? `还有 ${remaining} 条未裁决` : "全部裁决完成";
    els.applyMergeBtn.disabled = remaining > 0;
    els.applyMergeBtn.textContent = remaining ? "请先逐条裁决" : "应用裁决结果";
  }

  function previewValue(field, value) {
    if (field === "thumb") return value ? "（已上传缩略图）" : "（无缩略图）";
    if (field === "finalizedAt") return value ? `定版时间 ${new Date(value).toLocaleString()}` : "未定版";
    if (field === "status") return value === "finalized" ? "已定版" : "草稿";
    if (value === null || value === undefined || value === "") return "（空）";
    const text = String(value);
    return escapeHtml(text.length > 80 ? text.slice(0, 80) + "…" : text);
  }

  function conflictKindLabel(kind) {
    return { field: "字段冲突", "delete-modify": "删除/修改冲突", reference: "引用完整性冲突", order: "顺序冲突", runorder: "排练顺序冲突" }[kind] || "冲突";
  }

  els.conflictList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-conflict-index]");
    if (!btn) return;
    const conflict = mergePending.result.conflicts[Number(btn.dataset.conflictIndex)];
    conflict.resolution = btn.dataset.choice;
    const resolutions = {};
    mergePending.result.conflicts.forEach((c) => {
      if (c.resolution) resolutions[c.key] = c.resolution;
    });
    renderConflictList(resolutions);
  });

  els.applyMergeBtn.addEventListener("click", () => {
    if (!mergePending) return;
    const resolutions = {};
    mergePending.result.conflicts.forEach((c) => {
      if (c.resolution) resolutions[c.key] = c.resolution;
    });
    let result;
    if (mergePending.kind === "incoming") {
      result = store.resolveIncoming(resolutions);
    } else {
      result = store.resolveCommit(mergePending, resolutions);
    }
    if (result.status === "conflict") {
      mergePending.result = result.result;
      renderConflictList(resolutions);
      toast("仍有冲突未裁决。", "error");
      return;
    }
    els.mergeModal.hidden = true;
    mergePending = null;
    toast("冲突已按你的逐条裁决合并完成。", "success");
    renderAll();
  });

  els.adoptRemoteBtn.addEventListener("click", () => {
    if (!mergePending) return;
    if (mergePending.kind === "incoming") store.discardIncoming();
    store.adoptRemote(mergePending);
    els.mergeModal.hidden = true;
    mergePending = null;
    toast("已放弃本页修改，采用对方版本。", "warn");
    renderAll();
  });

  els.mergeCloseBtn.addEventListener("click", () => {
    if (mergePending && mergePending.kind === "incoming") store.discardIncoming();
    mergePending = null;
    els.mergeModal.hidden = true;
    renderAll();
  });

  /* ---------------- 撤销重做 / 暂停同步 ---------------- */

  els.undoBtn.addEventListener("click", () => {
    const result = store.undo();
    if (result.status === "conflict") openMerge({ ...result, kind: "commit" });
    renderAll();
  });
  els.redoBtn.addEventListener("click", () => {
    const result = store.redo();
    if (result.status === "conflict") openMerge({ ...result, kind: "commit" });
    renderAll();
  });

  els.pauseSyncBtn.addEventListener("click", () => {
    if (!store.isPaused()) {
      store.setPaused(true);
      toast("已暂停同步：接下来的修改只留在本页，可与另一页面分叉排练。", "warn");
    } else {
      const result = store.setPaused(false);
      if (result.status === "conflict") {
        openMerge({ ...result, kind: "resume" });
      } else if (result.autoMerged) {
        toast("恢复同步：已自动合并分叉期间的修改。", "success");
      } else {
        toast("已恢复实时同步。", "success");
      }
    }
    renderAll();
  });

  // 其他页面 storage 事件回调
  store.subscribe((event) => {
    if (event.type === "remote-conflict") {
      openMerge({ status: "conflict", remote: event.remote, result: event.result, kind: "incoming" });
    } else if (event.type === "remote-applied") {
      if (event.autoMerged) toast("另一页面有修改，已与本页自动合并。", "success");
      else toast("另一页面的更新已同步到本页。");
    } else if (event.type === "remote-paused") {
      toast("分叉排练中：另一个页面写入了更新，恢复同步时再合并。", "warn");
    }
    renderAll();
  });

  /* ---------------- 筛选 / 导入导出 ---------------- */

  els.colorFilter.addEventListener("change", renderAll);
  els.searchInput.addEventListener("input", renderAll);

  els.exportBtn.addEventListener("click", () => {
    download(`film-rehearsal-project-r${store.getRevision()}.json`, store.exportProject());
    toast("工程已导出（含片段库、各卷、排练记录与定版状态）。", "success");
  });

  els.exportTxtBtn.addEventListener("click", () => {
    const reel = activeReel();
    if (!reel) return;
    const s = state();
    const stats = M.reelStats(reel, s.library);
    const rows = M.reelSlotsWithSegments(reel, s.library);
    const orderMap = new Map((reel.runOrder || []).map((e) => [e.slotId, e]));
    const lines = [
      `胶片卷：${reel.title || "未命名胶片卷"}${reel.status === "finalized" ? "（已定版）" : ""}`,
      `总时长：${M.formatDuration(stats.duration)}　风险分：${stats.risk}`,
      "",
      ...rows.map((row, index) => {
        const seg = row.effective;
        const entry = orderMap.get(row.slot.id);
        const via = row.substitute ? "［替代生效］" : "";
        const run = entry
          ? `｜实际顺序 ${entry.order}｜${entry.source === "substitute" ? "替代放映" : "原片放映"}｜延误 ${entry.delay || 0}s${entry.delayReason ? `（${entry.delayReason}）` : ""}${entry.replaceReason ? `｜替换原因：${entry.replaceReason}` : ""}`
          : "｜未排练";
        return `${index + 1}. ${seg ? seg.code : "片段缺失"}${via}｜${seg ? M.formatDuration(seg.duration) : "-"}｜${seg ? seg.shift : "-"}｜${seg ? seg.damage : "-"}${run}｜${seg && seg.note ? seg.note : "无备注"}`;
      })
    ];
    download(`${reel.title || "film-reel"}-排练清单.txt`, lines.join("\n"), "text/plain;charset=utf-8");
  });

  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files[0];
    els.importFile.value = "";
    if (!file) return;
    const text = await file.text();
    const result = store.importProject(text);
    if (result.status === "invalid") {
      showImportResult(false, result.errors, result.warnings);
      return;
    }
    if (result.status === "conflict") {
      openMerge({ ...result.pending, kind: "commit" });
      return;
    }
    showImportResult(true, [], result.warnings || []);
    activeId = state().activeReelId || activeId;
    renderAll();
  });

  function showImportResult(ok, errors, warnings) {
    els.importModalTitle.textContent = ok ? "导入成功" : "导入被拒绝（数据未改动）";
    const errorHtml = errors.length
      ? `<div class="import-section"><h4>错误 ${errors.length} 条（必须修复后才能导入）：</h4><div class="import-error-list">
          ${errors.map((e) => `<div><span class="import-path">${escapeHtml(e.path)}</span> ${escapeHtml(e.message)}</div>`).join("")}
        </div></div>`
      : "";
    const warnHtml = warnings.length
      ? `<div class="import-section"><h4>自动修正/警告 ${warnings.length} 条：</h4><div class="import-warn-list">
          ${warnings.map((w) => `<div><span class="import-path">${escapeHtml(w.path)}</span> ${escapeHtml(w.message)}</div>`).join("")}
        </div></div>`
      : "";
    els.importResultBody.innerHTML = ok
      ? `<p class="empty-ok">工程已导入，现有数据被整体替换（可撤销）。</p>${warnHtml}`
      : `<p class="modal-sub">以下问题逐条列出，当前数据保持原样，没有被覆盖。</p>${errorHtml}${warnHtml}`;
    els.importModal.hidden = false;
  }

  /* ---------------- 通用弹窗关闭 / 确认 ---------------- */

  document.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-close-modal]");
    if (closer) {
      const modal = document.getElementById(closer.dataset.closeModal);
      if (modal) modal.hidden = true;
      if (closer.dataset.closeModal === "confirmModal") confirmHandler = null;
    }
  });

  els.confirmOkBtn.addEventListener("click", () => {
    els.confirmModal.hidden = true;
    const handler = confirmHandler;
    confirmHandler = null;
    if (handler) handler();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      [els.subModal, els.importModal, els.confirmModal].forEach((m) => (m.hidden = true));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      els.undoBtn.click();
    }
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      els.redoBtn.click();
    }
  });

  renderAll();
})();
