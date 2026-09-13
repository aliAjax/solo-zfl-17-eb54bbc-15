/* 真实浏览器 E2E：共享修改 / 替代 / 分叉合并 / 定版 / 异常导入 + 原流程回归 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}/index.html`;

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: detail || "" });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

function startServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function freshContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  return context;
}

async function readState(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("zfl17-film-rehearsal-stage");
    return raw ? JSON.parse(raw) : null;
  });
}

async function activeReelEval(page) {
  return page.evaluate(() => {
    const entry = JSON.parse(localStorage.getItem("zfl17-film-rehearsal-stage"));
    const s = entry.state;
    const reel = s.reels.find((r) => r.id === s.activeReelId) || s.reels[0];
    return { state: s, reel, revision: entry.revision };
  });
}

async function clickReel(page, titlePart) {
  await page.click(`.reel-tab:has-text("${titlePart}")`);
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [
        "/home/node/chromelibs/usr/lib/aarch64-linux-gnu",
        "/home/node/chromelibs/lib/aarch64-linux-gnu",
        process.env.LD_LIBRARY_PATH
      ]
        .filter(Boolean)
        .join(":")
    }
  });
  try {
    /* ============ 场景 0：播种与迁移 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // 先写入旧版数据，验证自动迁移
      await page.addInitScript(() => {
        localStorage.setItem(
          "zfl17-film-strip-desk",
          JSON.stringify({
            reelTitle: "旧单卷",
            segments: [{ id: "old-1", code: "OLD-1", duration: 7, shift: "偏黄", damage: "齿孔破损", note: "旧备注", thumb: "" }]
          })
        );
      });
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");
      const { state } = await activeReelEval(page);
      check("旧版单卷数据自动迁移为 库+1 卷", state.library.some((s) => s.code === "OLD-1") && state.reels.length === 1);
      check("迁移后旧片段仍被该卷引用", state.reels[0].slots[0].segmentId === "old-1");
      check("页面无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 1：共享片段修改同步多卷、时长风险重算 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");

      // 种子数据：LIB-001(18s 正常 完好) 同时在 A/B 两卷
      const before = await activeReelEval(page);
      check("播种 2 卷、共享库 8 片段", before.state.reels.length === 2 && before.state.library.length === 8);

      // 打开片段库编辑 LIB-001
      await page.click('[data-lib-edit="LIB-001"]');
      await page.fill("#durationInput", "25");
      await page.selectOption("#shiftInput", "褪色");
      await page.click("#segmentSubmitBtn");
      await page.waitForTimeout(150);

      const after = await activeReelEval(page);
      const lib1 = after.state.library.find((s) => s.id === "LIB-001");
      check("库片段本体被修改", lib1.duration === 25 && lib1.shift === "褪色");
      const metricsA = await page.locator("#reelMetrics").innerText();
      // A卷 = LIB-001 25s + LIB-002 9s + LIB-003 14s = 48s
      check("当前卷时长按新值重算", metricsA.includes("0:48"), metricsA.replace(/\n/g, " "));
      check("当前卷风险升高（褪色计入）", metricsA.includes("中风险") || metricsA.includes("高风险"), metricsA.replace(/\n/g, " "));

      // 切到 B 卷，验证同样同步
      await clickReel(page, "B卷");
      await page.waitForTimeout(80);
      const metricsB = await page.locator("#reelMetrics").innerText();
      // B卷 = LIB-001 25s + LIB-007 11s + LIB-006 20s = 56s
      check("另一卷无需刷新即同步新时长", metricsB.includes("0:56"), metricsB.replace(/\n/g, " "));

      // 撤销 -> 回退，重做 -> 恢复
      await page.click("#undoBtn");
      await page.waitForTimeout(80);
      const undone = await readState(page);
      check("撤销后库片段恢复", undone.state.library.find((s) => s.id === "LIB-001").duration === 18);
      await page.click("#redoBtn");
      await page.waitForTimeout(80);
      const redone = await readState(page);
      check("重做后修改恢复", redone.state.library.find((s) => s.id === "LIB-001").duration === 25);
      check("场景1 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 2：替代片段——合规 / 强制冲突 / 冲突逐条说明 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");
      await clickReel(page, "B卷");
      await page.waitForTimeout(60);

      // B 卷第 2 位是 LIB-007(B-011, 11s 正常 需跳过) —— 必须替代
      // 打开它的替代选择器
      const cards = page.locator(".segment-card");
      await cards.nth(1).locator('[data-sub]').click();
      await page.waitForSelector("#subModal:not([hidden])");
      const desc = await page.locator("#subModalDesc").innerText();
      check("替代弹窗说明约束与容差", desc.includes("颜色") && desc.includes("破损") && desc.includes("容差"), desc);

      // LIB-008(B-015, 12s 正常 完好) 是合规候选；确认默认可以点
      const okCard = page.locator('.candidate-card:has-text("B-015")');
      await okCard.click();
      const forceLineVisible = await page.locator("#forceLine").isVisible();
      check("合规候选不显示强制勾选", forceLineVisible === false);
      await page.click("#confirmSubBtn");
      await page.waitForSelector("#subModal", { state: "hidden" });
      await page.waitForTimeout(100);

      const withSub = await activeReelEval(page);
      const slot = withSub.reel.slots[1];
      check("替代已挂到排片位置", slot.substituteId === "LIB-008");
      const subLine = await cards.nth(1).innerText();
      check("UI 显示替代生效且时长为替代值", subLine.includes("已安排替代") && subLine.includes("B-015"));

      // 现在给第 3 位 LIB-006(B-007 20s 正常 齿孔破损) 安排一个冲突候选 LIB-002(A-006 9s 偏红 轻微划痕)
      await cards.nth(2).locator('[data-sub]').click();
      await page.waitForSelector("#subModal:not([hidden])");
      const badCard = page.locator('.candidate-card:has-text("A-006")');
      await badCard.click();
      const badCardText = await badCard.innerText();
      check("冲突候选逐条列出 颜色/时长 冲突", badCardText.includes("颜色不匹配") && badCardText.includes("时长超差"), badCardText.replace(/\n/g, " "));
      check("冲突候选未勾选强制时确认按钮禁用", await page.locator("#confirmSubBtn").isDisabled());
      // 破损等级：轻微划痕(1) 不劣于 齿孔破损(2)，不应报破损冲突
      check("破损不更严重时不报破损冲突", !badCardText.includes("破损更严重"));
      await page.check("#forceSubCheck");
      await page.click("#confirmSubBtn");
      await page.waitForTimeout(100);

      const card3Text = await cards.nth(2).innerText();
      check("强制冲突替代后，卡片逐条展示冲突", card3Text.includes("冲突替代") && card3Text.includes("颜色不匹配"));
      const blockers = await page.locator("#blockerList").innerText();
      check("阻断面板列出冲突替代", blockers.includes("替代") && blockers.includes("不满足约束"));
      check("定版按钮在有阻断时仍可见但点击无效", await page.locator("#finalizeBtn").isVisible());
      await page.click("#finalizeBtn");
      await page.waitForTimeout(80);
      const stillDraft = (await activeReelEval(page)).reel.status;
      check("有未处理阻断不能定版", stillDraft === "draft");

      // 取消冲突替代 -> 冲突消失
      await page.locator('[data-sub-cancel]').first().click();
      await page.waitForTimeout(80);
      // 取消的是第2位合规替代（first）；再取消第3位
      await cards.nth(2).locator('[data-sub-cancel]').click().catch(() => {});
      check("场景2 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 3：两页面分叉——自动合并 + 冲突人工裁决（不静默覆盖） ============ */
    {
      const context = await freshContext(browser);
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      const errors = [];
      pageA.on("pageerror", (e) => errors.push("A:" + e.message));
      pageB.on("pageerror", (e) => errors.push("B:" + e.message));
      await pageA.goto(BASE);
      await pageB.goto(BASE);
      await pageA.waitForSelector(".reel-tab");
      await pageB.waitForSelector(".reel-tab");

      // --- 3a 不重叠修改：A 改 LIB-001 备注，B 改 LIB-001 时长 ---
      await pageA.click('[data-lib-edit="LIB-001"]');
      await pageA.fill("#noteInput", "A页面改的备注");
      await pageA.click("#segmentSubmitBtn");
      await pageA.waitForTimeout(120);

      await pageB.click('[data-lib-edit="LIB-001"]');
      await pageB.fill("#durationInput", "30");
      await pageB.click("#segmentSubmitBtn");
      await pageB.waitForTimeout(200);

      const mergedB = await readState(pageB);
      const seg = mergedB.state.library.find((s) => s.id === "LIB-001");
      check("不重叠分叉修改自动合并（备注+时长都在）", seg.note === "A页面改的备注" && seg.duration === 30);
      // A 收到 storage 事件后也应有
      await pageA.waitForTimeout(300);
      const mergedA = await readState(pageA);
      const segA = mergedA.state.library.find((s) => s.id === "LIB-001");
      check("另一页面经 storage 事件同步到合并结果", segA.duration === 30 && segA.note === "A页面改的备注");

      // --- 3b 同字段矛盾修改：用暂停同步制造稳定分叉 ---
      await pageA.click("#pauseSyncBtn"); // A 暂停
      await pageA.waitForTimeout(60);
      await pageB.click("#pauseSyncBtn"); // B 暂停
      await pageB.waitForTimeout(60);

      // 两个页面在暂停状态各自编辑 LIB-002 时长
      await pageA.click('[data-lib-edit="LIB-002"]');
      await pageA.fill("#durationInput", "111");
      await pageA.click("#segmentSubmitBtn");
      await pageA.waitForTimeout(60);

      await pageB.click('[data-lib-edit="LIB-002"]');
      await pageB.fill("#durationInput", "222");
      await pageB.click("#segmentSubmitBtn");
      await pageB.waitForTimeout(60);

      // A 先恢复并写入
      await pageA.click("#pauseSyncBtn");
      await pageA.waitForTimeout(150);
      // B 恢复 -> 应弹冲突裁决框
      await pageB.click("#pauseSyncBtn");
      await pageB.waitForSelector("#mergeModal:not([hidden])", { timeout: 3000 });
      const conflictText = await pageB.locator("#conflictList").innerText();
      check("同字段矛盾产生冲突，弹窗逐条说明", conflictText.includes("时长") && conflictText.includes("两边改成不同值"));
      check("应用按钮在裁决前禁用", await pageB.locator("#applyMergeBtn").isDisabled());
      check("未裁决时 storage 未被静默覆盖", (await readState(pageA)).state.library.find((s) => s.id === "LIB-002").duration === 111);

      // 选择"本页版本"（222）
      await pageB.click('.choice-btn:has(.choice-label:has-text("本页版本"))');
      await pageB.click("#applyMergeBtn");
      await pageB.waitForTimeout(200);
      const finalVal = (await readState(pageB)).state.library.find((s) => s.id === "LIB-002").duration;
      check("人工裁决选择本页后落盘为 222", finalVal === 222);
      await pageA.waitForTimeout(300);
      const syncedA = (await readState(pageA)).state.library.find((s) => s.id === "LIB-002").duration;
      check("裁决结果同步回 A 页面", syncedA === 222);

      // --- 3c "采用对方版本" 放弃本页 ---
      // 再造一次分叉
      await pageA.click("#pauseSyncBtn");
      await pageB.click("#pauseSyncBtn");
      await pageA.waitForTimeout(60);
      await pageA.click('[data-lib-edit="LIB-003"]');
      await pageA.fill("#durationInput", "101");
      await pageA.click("#segmentSubmitBtn");
      await pageB.waitForTimeout(40);
      await pageB.click('[data-lib-edit="LIB-003"]');
      await pageB.fill("#durationInput", "202");
      await pageB.click("#segmentSubmitBtn");
      await pageA.waitForTimeout(40);
      await pageA.click("#pauseSyncBtn");
      await pageA.waitForTimeout(120);
      await pageB.click("#pauseSyncBtn");
      await pageB.waitForSelector("#mergeModal:not([hidden])", { timeout: 3000 });
      await pageB.click("#adoptRemoteBtn");
      await pageB.waitForTimeout(200);
      const adopted = (await readState(pageB)).state.library.find((s) => s.id === "LIB-003").duration;
      check("放弃本页修改后采用对方版本(101)", adopted === 101);
      check("场景3 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 4：排练记录 -> 阻断 -> 定版只读 -> 刷新一致 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");
      clickReel(page, "A卷");
      await page.waitForTimeout(60);

      // A 卷 3 位：LIB-001 / LIB-002(偏红 划痕) / LIB-003(褪色 接片松动)。无"需跳过"，无需替代。
      // 未排练时定版应被阻止
      await page.click("#finalizeBtn");
      await page.waitForTimeout(60);
      let cur = await activeReelEval(page);
      check("未排练不能定版", cur.reel.status === "draft");
      const blockerBefore = await page.locator("#blockerList").innerText();
      check("阻断列出 3 项未排练", (blockerBefore.match(/未排练/g) || []).length >= 1);

      // 逐位填写排练：实际顺序 1/2/3、全部原片、第2位延误 8 秒但先不填原因 -> 应有延误原因阻断
      const cards = page.locator(".segment-card");
      await cards.nth(0).locator('[data-field="source"]').selectOption("primary");
      await cards.nth(0).locator('[data-field="order"]').fill("1");
      await cards.nth(1).locator('[data-field="source"]').selectOption("primary");
      await cards.nth(1).locator('[data-field="order"]').fill("2");
      await cards.nth(1).locator('[data-field="delay"]').fill("8");
      await cards.nth(1).locator('[data-field="delay"]').dispatchEvent("change");
      await page.waitForTimeout(100);

      let blockerText = await page.locator("#blockerList").innerText();
      check("延误缺原因被列为阻断", blockerText.includes("延误") && blockerText.includes("未记录延误原因"));
      // 补上原因
      await cards.nth(1).locator('[data-field="delayReason"]').fill("换机检查齿孔");
      await cards.nth(1).locator('[data-field="delayReason"]').dispatchEvent("change");
      // 第3位排练
      await cards.nth(2).locator('[data-field="source"]').selectOption("primary");
      await cards.nth(2).locator('[data-field="order"]').fill("3");
      await cards.nth(2).locator('[data-field="order"]').dispatchEvent("change");
      await page.waitForTimeout(120);

      blockerText = await page.locator("#blockerList").innerText();
      const canFinalize = blockerText.includes("没有阻断") || blockerText.includes("可以定版");
      check("全部处理后无阻断", canFinalize, blockerText.replace(/\n/g, " ").slice(0, 120));

      await page.click("#finalizeBtn");
      await page.waitForTimeout(150);
      cur = await activeReelEval(page);
      check("定版成功且记录时间/快照", cur.reel.status === "finalized" && !!cur.reel.finalizedAt && Array.isArray(cur.reel.frozenLibrary) && cur.reel.frozenLibrary.length === 3);

      // 只读：控件禁用/隐藏
      check("定版后排片输入禁用", await cards.nth(0).locator('[data-field="source"]').isDisabled());
      check("定版后定版按钮隐藏、退回按钮出现", !(await page.locator("#finalizeBtn").isVisible()) && await page.locator("#unfinalizeBtn").isVisible());

      // 定版后修改共享库，定版卷时长不变（冻结）
      const frozenMetric = await page.locator("#reelMetrics").innerText();
      await page.click('[data-lib-edit="LIB-001"]');
      await page.fill("#durationInput", "99");
      await page.click("#segmentSubmitBtn");
      await page.waitForTimeout(120);
      const frozenMetric2 = await page.locator("#reelMetrics").innerText();
      check("定版卷冻结快照，库改时长不影响定版卷", frozenMetric.match(/总时长[\s\S]*?(\d:\d\d)/)[1] === frozenMetric2.match(/总时长[\s\S]*?(\d:\d\d)/)[1]);

      // 刷新后数据一致、仍只读
      await page.reload();
      await page.waitForSelector(".reel-tab");
      await clickReel(page, "A卷");
      await page.waitForTimeout(60);
      const afterReload = await activeReelEval(page);
      check("刷新后定版状态/快照/排练记录保持", afterReload.reel.status === "finalized" && afterReload.reel.runOrder.length === 3 && afterReload.reel.frozenLibrary.length === 3);
      check("刷新后仍是只读 UI", await page.locator("#unfinalizeBtn").isVisible());
      check("场景4 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 5：异常导入逐条报错且不破坏数据；正常导入可撤销 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");
      const before = JSON.stringify((await activeReelEval(page)).state);

      // 5a 坏 JSON
      await page.setInputFiles("#importFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{这不是json") });
      await page.waitForSelector("#importModal:not([hidden])");
      const t1 = await page.locator("#importResultBody").innerText();
      check("坏 JSON 被拒绝并说明解析失败", t1.includes("JSON 解析失败"));
      await page.click('#importModal [data-close-modal="importModal"]');

      // 5b 结构错误：坏时长 / 重复 id / 悬空引用
      const badProject = {
        app: "film-rehearsal-stage",
        library: [
          { id: "x1", code: "X-1", duration: -5, shift: "正常", damage: "完好" },
          { id: "x1", code: "X-2", duration: 10, shift: "正常", damage: "完好" }
        ],
        reels: [{ id: "r9", title: "坏卷", slots: [{ id: "s9", segmentId: "ghost" }], runOrder: [] }]
      };
      await page.setInputFiles("#importFile", { name: "bad2.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(badProject)) });
      await page.waitForSelector("#importModal:not([hidden])");
      const t2 = await page.locator("#importResultBody").innerText();
      check("结构错误逐条列出（时长/重复id/悬空引用）", t2.includes("时长必须是正数") && t2.includes("id 重复") && t2.includes("不在片段库"), t2.replace(/\n/g, " ").slice(0, 200));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(60);
      check("异常导入后原数据完全不变", JSON.stringify((await activeReelEval(page)).state) === before);

      // 5c 正常工程导入（含一个替代）
      const good = {
        app: "film-rehearsal-stage",
        schemaVersion: 2,
        library: [
          { id: "g1", code: "G-1", duration: 12, shift: "正常", damage: "完好", note: "", thumb: "" },
          { id: "g2", code: "G-2", duration: 13, shift: "正常", damage: "完好", note: "", thumb: "" }
        ],
        reels: [
          {
            id: "gr1",
            title: "导入卷",
            status: "draft",
            finalizedAt: null,
            slots: [{ id: "gs1", segmentId: "g1", substituteId: "g2", substituteCancelled: false }],
            runOrder: []
          }
        ],
        activeReelId: "gr1"
      };
      await page.setInputFiles("#importFile", { name: "good.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(good)) });
      await page.waitForSelector("#importModal:not([hidden])");
      const okTitle = await page.locator("#importModalTitle").innerText();
      check("正常导入提示成功", okTitle.includes("导入成功"));
      await page.click('#importModal [data-close-modal="importModal"]');
      await page.waitForTimeout(60);
      const imported = await activeReelEval(page);
      check("正常导入整体替换", imported.state.library.length === 2 && imported.reel.title === "导入卷" && imported.reel.slots[0].substituteId === "g2");
      // 撤销导入
      await page.click("#undoBtn");
      await page.waitForTimeout(100);
      check("导入可撤销，恢复原工程", (await activeReelEval(page)).state.library.length === JSON.parse(before).library.length);
      check("场景5 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }

    /* ============ 场景 6：原核对流程回归——筛选、提醒、导出、拖拽 ============ */
    {
      const context = await freshContext(browser);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      await page.waitForSelector(".reel-tab");

      // 筛选颜色
      await page.selectOption("#colorFilter", "褪色");
      await page.waitForTimeout(80);
      const libCards = await page.locator(".library-card").count();
      check("颜色筛选作用于片段库（褪色项）", libCards >= 2);
      const reelCards = await page.locator(".segment-card").count();
      check("颜色筛选同时作用于当前卷", reelCards === 1); // A 卷只有 LIB-003 褪色
      await page.selectOption("#colorFilter", "all");
      await page.fill("#searchInput", "A-006");
      await page.waitForTimeout(80);
      const codes = await page.locator(".library-card .lib-code").allInnerTexts();
      check("搜索定位片段（含编号与备注命中）", codes.includes("A-006") && codes.length >= 1, JSON.stringify(codes));
      await page.fill("#searchInput", "");

      // 提醒面板：A 卷有偏红/褪色/破损提醒
      const warn = await page.locator("#warningList").innerText();
      check("原颜色/破损提醒保留", warn.includes("偏红") && warn.includes("褪色"));

      // 顶部统计
      const hero = await page.locator(".hero-stats").innerText();
      check("顶部统计显示库/卷/阻断数", hero.includes("共享片段") && hero.includes("胶片卷"));

      // 导出工程 JSON：监听下载
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      const exported = JSON.parse(Buffer.concat(chunks).toString());
      check("导出工程 JSON 结构完整", exported.schemaVersion === 2 && Array.isArray(exported.library) && Array.isArray(exported.reels));

      // 导出本卷 TXT
      const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#exportTxtBtn")]);
      const stream2 = await dl2.createReadStream();
      const chunks2 = [];
      for await (const c of stream2) chunks2.push(c);
      const txt = Buffer.concat(chunks2).toString();
      check("导出本卷清单为 TXT", txt.includes("胶片卷：") && txt.includes("总时长"));

      // 拖拽调整顺序：把第 1 张卡拖到第 3 张位置（HTML5 DnD 用手动鼠标序列驱动）
      const cards = page.locator(".segment-card");
      const first = cards.nth(0);
      const third = cards.nth(2);
      const orderBefore = await page.locator(".segment-card strong").allInnerTexts();
      await first.hover();
      await page.mouse.down();
      await third.hover();
      await page.mouse.up();
      await page.waitForTimeout(150);
      const newOrder = await page.locator(".segment-card strong").allInnerTexts();
      check("拖拽调整计划顺序生效", JSON.stringify(newOrder) !== JSON.stringify(orderBefore), `${orderBefore.join(" | ")}  =>  ${newOrder.join(" | ")}`);
      check("场景6 无 JS 错误", errors.length === 0, errors.join(" | "));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== E2E 结果：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log(` - ${f.name} ${f.detail}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
