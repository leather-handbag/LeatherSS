const platformMeta = {
  codeforces: { name: "Codeforces", icon: "CF", field: "Organization" },
  atcoder: { name: "AtCoder", icon: "AC", field: "Affiliation" },
};

export function createTrainingWorld({ api, $, $$, esc, toast, nowText, openModal, avatarHtml }) {
  const state = { dashboard: null, targetId: "", own: false, activeMap: "", heatmap: [], heatmapTarget: "", reports: [], initialized: false };

  const dateKey = date => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
  const shortDate = value => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(`${value}T12:00:00+08:00`));
  const statusText = status => ({ active: "同步正常", degraded: "暂时降级", reverify_required: "需要重新验证", disabled: "已停用" }[status] || status || "等待同步");
  const assessmentText = value => ({ strength: "强项", weakness: "弱项", unexplored: "待探索", rusty: "略显生疏", steady: "稳定推进" }[value] || "待探索");
  const slotText = value => ({ weakness: "补短板", progress: "推地图", explore: "探遗迹" }[value] || value);

  function publicShape(profile) {
    return { generated_at: profile.generated_at, model_version: profile.model_version, classification_coverage: 0, summary: profile.summary || {}, ability_estimate: profile.ability_estimate || {}, accounts: profile.accounts || [], maps: profile.maps || [], logs: [], privacy: {}, profile };
  }

  async function renderWorld(targetId = "") {
    if (!api.cloud.configured) { locked("等待 Supabase 配置", "应用算法远征迁移并部署 Edge Functions 后即可读取真实训练数据。");return; }
    const target = targetId || api.cloud.user?.id || "";
    if (!target) { location.hash = "account";return; }
    state.targetId = target;state.own = target === api.cloud.user?.id;
    $("#trainingRefreshBtn").classList.toggle("hidden", !state.own);
    $("#trainingMonthlyReportPanel").classList.toggle("hidden", !state.own);
    $("#trainingWorldOwnerNote").textContent = state.own ? "公开提交会化为地图上的足迹；每项判断都附带证据量和置信度。" : "正在查看公开的算法远征档案。";
    $("#trainingDashboard").classList.remove("hidden");$("#trainingLocked").classList.add("hidden");
    $("#trainingMapTrail").innerHTML = '<div class="training-loading">正在展开地图图册……</div>';
    try {
      let data;
      if (state.own) data = await api.fetchTrainingDashboard();
      else {
        const profile = await api.fetchTrainingProfile(target);
        if (!profile) throw new Error("没有找到这位探险家");
        if (!profile.visibility?.map || !profile.maps) { locked("这位探险家隐藏了地图", "隐私设置阻止了能力地图与强弱项的公开读取。");return; }
        data = publicShape(profile);
      }
      state.dashboard = data;
      state.activeMap = pickActiveMap(data.maps || []);
      renderDashboard(data);
      await Promise.allSettled([loadHeatmap(), renderExplorerRanking(), state.own ? loadRecommendations() : Promise.resolve(), state.own ? loadReports() : Promise.resolve()]);
    } catch (error) { locked("地图暂时无法展开", error.message); }
  }

  function locked(title, message) {
    $("#trainingDashboard").classList.add("hidden");$("#trainingLocked").classList.remove("hidden");
    $("#trainingLocked").innerHTML = `<span>♙</span><h2>${esc(title)}</h2><p>${esc(message)}</p>`;
  }

  function pickActiveMap(maps) {
    const unlocked = maps.filter(map => map.unlocked);
    return ([...unlocked].reverse().find(map => !map.mastered) || unlocked.at(-1) || maps[0])?.code || "plains";
  }

  function renderDashboard(data) {
    const maps = data.maps || [];const active = maps.find(map => map.code === state.activeMap) || maps[0] || {};
    const summary = data.summary || {};const profile = data.profile?.user;
    $("#trainingWorldTitle").textContent = state.own ? "展开你的算法远征图册。" : `${profile?.display_name || "探险家"}的算法远征`;
    $("#trainingFreshness").textContent = `${Number(summary.freshness || 0)}°`;
    $("#trainingCurrentMap").textContent = active.unlocked ? `当前远征：${active.name || "启程平原"}` : "等待第一份远征记录";
    const through = data.data_through ? nowText(Date.parse(data.data_through)) : "尚未完成同步";
    $("#trainingDataCaption").textContent = `数据截至 ${through} · 评分模型 v${data.model_version || 1}`;
    $("#trainingSolved").textContent = Number(summary.solved || 0);$("#trainingActiveDays").textContent = Number(summary.active_days || 0);$("#trainingMapsUnlocked").textContent = Number(summary.maps_unlocked || maps.filter(v => v.unlocked).length || 1);$("#trainingCoverage").textContent = `${Number(data.classification_coverage || 0)}%`;
    renderSources(data.accounts || []);renderAbility(data.ability_estimate || {});renderTrail(maps);renderRegions(active);renderRadar(maps);renderAssessments(maps);renderLogs(data.logs || []);
    $("#trainingModelBadge").textContent = `模型 v${data.model_version || 1}`;
    $("#trainingActiveMapTitle").textContent = active.name || "启程平原";
    if (!state.own) $("#trainingRecommendationList").innerHTML = '<div class="training-empty">每日推荐只对本人可见。</div>';
  }

  function renderAbility(value) {
    const average = value.hard_problem_average == null ? "待计算" : Math.round(Number(value.hard_problem_average));
    $("#trainingAbilityAverage").textContent = average;
    $("#trainingAbilitySample").textContent = `${Number(value.sample_size || 0)} / ${Number(value.known_solved_count || 0)} 道`;
    $("#trainingAbilityMaximum").textContent = value.max_difficulty == null ? "—" : Number(value.max_difficulty);
    $("#trainingAbilityRecent").textContent = value.recent_90d_average == null ? "—" : Math.round(Number(value.recent_90d_average));
    const direct = (state.dashboard?.maps || []).find(map => map.code === value.direct_unlock_map);
    $("#trainingAbilityDirect").textContent = direct ? `能力直达 ${direct.name}` : "尚未触发能力直达";
    $("#trainingAbilityNote").textContent = value.sample_size ? `取去重后最难的 ${Number(value.sample_size)} 道题计算；直达只开放地图，不会伪造区域掌握度。` : "至少需要 5 道有标准难度的独立 AC 才能评估地图直达。";
  }

  function renderSources(accounts) {
    $("#trainingSourcePills").innerHTML = accounts.length ? accounts.map(account => `<a class="source-pill ${esc(account.status)}" href="${esc(account.profile_url)}" target="_blank" rel="noopener noreferrer"><b>${esc(platformMeta[account.platform]?.icon || "?")}</b><span>${esc(account.handle)}<small>${esc(statusText(account.status))}${account.data_through ? ` · ${nowText(Date.parse(account.data_through))}` : ""}</small></span></a>`).join("") : `<a class="source-pill empty" href="#settings"><b>＋</b><span>绑定竞赛平台<small>开始同步公开提交</small></span></a>`;
  }

  function renderTrail(maps) {
    $("#trainingMapTrail").innerHTML = maps.map((map, index) => `<button class="map-node ${map.unlocked ? "unlocked" : "locked"} ${map.code === state.activeMap ? "active" : ""}" data-map-code="${esc(map.code)}" type="button" role="listitem" aria-pressed="${map.code === state.activeMap}" title="${esc((map.algorithms || []).join("、"))}"><i style="--map-color:${esc(map.color)}">${map.unlocked ? esc(map.icon) : "?"}</i><span><small>MAP ${String(index + 1).padStart(2, "0")}</small><b>${esc(map.name)}</b><em>${map.unlocked ? `${Number(map.progress || 0)}%${map.mastered ? " · 已制霸" : ""}` : "可查看算法范围"}</em></span>${index < maps.length - 1 ? '<u aria-hidden="true"></u>' : ""}</button>`).join("");
    $$('[data-map-code]', $("#trainingMapTrail")).forEach(button => button.onclick = () => { state.activeMap = button.dataset.mapCode;const active = state.dashboard.maps.find(map => map.code === state.activeMap);renderTrail(state.dashboard.maps);renderRegions(active);renderRadar(state.dashboard.maps);$("#trainingActiveMapTitle").textContent = active.name; });
  }

  function renderRegions(map) {
    if (!map?.unlocked) { $("#trainingRegionGrid").innerHTML = `<div class="training-fog"><span>≈</span><h3>${esc(map?.name || "未知地图")}仍被迷雾覆盖</h3><p>包含：${esc((map?.algorithms || []).join("、") || "算法区域待配置")}。</p><p>可通过制霸上一地图，或达到高难过题平均难度门槛永久解锁。</p></div>`;return; }
    const regions = map.regions || [];
    $("#trainingRegionGrid").innerHTML = regions.map(region => `<article class="map-region ${region.core ? "core" : "relic"} assessment-${esc(region.assessment)}" tabindex="0" title="${esc(region.explanation)}"><div class="region-orb" style="--region-p:${Number(region.percent || 0)};--region-color:${esc(map.color)}"><span>${esc(region.icon)}</span></div><div><div class="region-name"><h3>${esc(region.name)}</h3><b>${Number(region.percent || 0)}%</b></div><p>${esc(region.explanation || region.description)}</p><div class="region-evidence"><span>证据 ${Number(region.evidence || 0).toFixed(1)} / ${Number(region.evidence_target || 0)}</span><span>上段 ${Number(region.upper_evidence || 0).toFixed(1)} / ${Number(region.upper_target || 0)}</span><span>子技能 ${Number(region.covered_skills || 0)} / ${Number(region.required_skills || 0)}</span><span>训练日 ${Number(region.active_days || 0)} / ${Number(region.required_days || 4)}</span></div><footer><span class="confidence confidence-${esc(region.confidence)}">${esc(region.confidence === "high" ? "高置信" : region.confidence === "medium" ? "中置信" : "低置信")}</span><span>${Number(region.solved || 0)} 道有效 AC</span><span>${region.core ? "核心区域" : "遗迹区域"}</span></footer></div></article>`).join("") || '<div class="training-empty">这张地图还没有区域配置。</div>';
  }

  function renderRadar(maps) {
    const map = maps.find(item => item.code === state.activeMap);const regions = (map?.regions || []).filter(region => region.core).slice(0, 6);
    if (regions.length < 3) { $("#trainingRadar").innerHTML = '<div class="training-empty">同步更多有可靠标签的题目后生成能力轮廓。</div>';return; }
    const size = 260,center = 130,radius = 92;
    const point = (index, factor = 1) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / regions.length;return `${center + Math.cos(angle) * radius * factor},${center + Math.sin(angle) * radius * factor}`; };
    const axes = regions.map((_, index) => `<line x1="${center}" y1="${center}" x2="${point(index).split(',')[0]}" y2="${point(index).split(',')[1]}"/>`).join("");
    const labels = regions.map((region, index) => { const [x,y] = point(index,1.23).split(',');return `<text x="${x}" y="${y}">${esc(region.name.slice(0,6))}</text>`; }).join("");
    $("#trainingRadar").innerHTML = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(map.name)}能力雷达"><polygon class="radar-grid" points="${regions.map((_,i)=>point(i)).join(' ')}"/><g class="radar-axes">${axes}</g><polygon class="radar-value" points="${regions.map((r,i)=>point(i,Math.max(.04,Number(r.percent||0)/100))).join(' ')}"/>${labels}</svg><div class="radar-caption">${esc(map.name)}核心板块的相对掌握度</div>`;
  }

  function renderAssessments(maps) {
    const regions = maps.filter(map => map.unlocked).flatMap(map => (map.regions || []).filter(region => region.core));
    const sorted = [...regions].sort((a,b) => { const rank = { strength:0, weakness:1, rusty:2, steady:3, unexplored:4 };return (rank[a.assessment] ?? 5) - (rank[b.assessment] ?? 5) || Number(b.percent)-Number(a.percent); }).slice(0, 8);
    $("#trainingAssessmentList").innerHTML = sorted.length ? sorted.map(region => `<article class="assessment-row ${esc(region.assessment)}"><span>${esc(assessmentText(region.assessment))}</span><div><b>${esc(region.name)} · ${Number(region.percent)}%</b><p>${esc(region.explanation)}</p></div></article>`).join("") : '<div class="training-empty">证据不足时不会武断地判定弱项。</div>';
  }

  function renderLogs(logs) {
    $("#trainingLogList").innerHTML = logs.length ? logs.map(log => `<article><i>${log.type === "map_unlocked" ? "✦" : log.type === "binding" ? "⛓" : "⌁"}</i><div><b>${esc(log.title)}</b><p>${esc(log.message)}</p><small>${nowText(Date.parse(log.created_at))}</small></div></article>`).join("") : '<div class="training-empty">绑定平台后，重要的远征事件会记录在这里。</div>';
  }

  async function loadHeatmap() {
    const target = state.targetId;if (!target) return;
    const range = $("#trainingHeatmapRange").value;const now = new Date();let from;
    if (range === "calendar") from = `${now.getFullYear()}-01-01`;else if (range === "all") from = "2000-01-01";else { const date = new Date(now);date.setDate(date.getDate()-364);from = dateKey(date); }
    const platform = $("#trainingHeatmapPlatform").value || null;
    try { state.heatmap = await api.fetchTrainingHeatmap(target, from, dateKey(now), platform);state.heatmapTarget = target;renderHeatmap(from, dateKey(now), state.heatmap); }
    catch (error) { $("#trainingHeatmap").innerHTML = `<div class="training-empty">${esc(/private/i.test(error.message) ? "这位探险家隐藏了热力图。" : error.message)}</div>`; }
  }

  function renderHeatmap(from, to, rows) {
    const byDay = new Map();for (const row of rows) { const old = byDay.get(row.activity_date) || { attempts:0,accepted:0,solved:0,platforms:{} };old.attempts += Number(row.submission_count);old.accepted += Number(row.accepted_submissions);old.solved += Number(row.solved_count);old.platforms[row.platform] = { attempts:Number(row.submission_count),solved:Number(row.solved_count) };byDay.set(row.activity_date,old); }
    const start = new Date(`${from}T12:00:00+08:00`), end = new Date(`${to}T12:00:00+08:00`);const days=[];
    if ((end-start)/86400000 > 550) { for (const [date,value] of byDay) days.push({date,value});days.sort((a,b)=>a.date.localeCompare(b.date)); }
    else for (let date=new Date(start);date<=end;date.setDate(date.getDate()+1)) { const key=dateKey(date);days.push({date:key,value:byDay.get(key)||{attempts:0,accepted:0,solved:0,platforms:{}}}); }
    const max=Math.max(1,...days.map(day=>day.value.solved));const level=value=>value===0?0:Math.min(4,Math.max(1,Math.ceil(value/max*4)));
    $("#trainingHeatmap").style.setProperty("--heatmap-weeks",Math.max(1,Math.ceil(days.length/7)));
    $("#trainingHeatmap").innerHTML = days.map(day=>`<button type="button" class="heat-cell level-${level(day.value.solved)}" data-heat-date="${day.date}" aria-label="${day.date}，${day.value.solved} 道 AC" title="${day.date} · ${day.value.solved} 道独立 AC · ${day.value.attempts} 次尝试"></button>`).join("");
    $$('[data-heat-date]', $("#trainingHeatmap")).forEach(button=>button.onclick=()=>{ const value=byDay.get(button.dataset.heatDate)||{attempts:0,accepted:0,solved:0,platforms:{}};const parts=Object.entries(value.platforms).map(([p,v])=>`${platformMeta[p]?.name||p} ${v.solved} AC / ${v.attempts} 尝试`);$("#trainingHeatmapDetail").innerHTML=`<b>${esc(button.dataset.heatDate)} · ${shortDate(button.dataset.heatDate)}</b><span>${value.solved} 道独立 AC · ${value.accepted} 次通过提交 · ${value.attempts} 次尝试</span><small>${esc(parts.join("　")||"当天没有公开提交")}</small>`; });
  }

  async function loadRecommendations() {
    try { const rows=await api.fetchTrainingRecommendations(3);$("#trainingRecommendationList").innerHTML=rows.length?rows.map(row=>{const map=(state.dashboard?.maps||[]).find(item=>item.code===row.map_code);const region=map?.regions?.find(item=>item.code===row.region_code);return `<article class="quest-card"><span>${esc(slotText(row.slot))}</span><h3>${esc(row.title)}</h3><p>${esc(row.reason)}</p><small class="quest-route">${esc(map?.name||row.map_code||"探索地图")} · ${esc(region?.name||"随机探索")}</small><div><small>${esc(platformMeta[row.platform]?.name||row.platform)} · ${row.difficulty??"难度未知"}</small><a class="btn primary small" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">出发</a><button class="text-btn" data-skip-rec="${row.id}" type="button">暂不想做</button></div></article>`;}).join(""):'<div class="training-empty">题目目录与可靠标签积累后，将生成三条个性化路线。</div>';$$('[data-skip-rec]').forEach(button=>button.onclick=async()=>{await api.skipTrainingRecommendation(button.dataset.skipRec);button.closest('article')?.remove();toast("已跳过，七天内不会再次推荐");}); }
    catch(error){$("#trainingRecommendationList").innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;}
  }

  async function renderExplorerRanking() {
    try { const rows=await api.fetchExplorerLeaderboard(10);$("#trainingExplorerRanking").innerHTML=rows.length?rows.map((row,index)=>`<a href="#training-world/${encodeURIComponent(row.user_id)}"><em>${String(index+1).padStart(2,'0')}</em>${avatarHtml(row)}<span><b>${esc(row.display_name)}</b><small>${Number(row.mastered_maps||0)} 张制霸 · ${Number(row.maps_unlocked)} 张开放 · ${Number(row.mastery_total)} 总掌握度</small></span></a>`).join(""):'<div class="training-empty">还没有公开的探险记录。</div>'; }
    catch(error){$("#trainingExplorerRanking").innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;}
  }

  const reportTypeText = value => ({ baseline: "基线报告", rest_month: "休整月", monthly: "月度报告" }[value] || "月度报告");
  async function loadReports() {
    const list = $("#trainingReportArchive"), detail = $("#trainingReportDetail");
    if (!list || !detail) return;
    try {
      state.reports = await api.fetchLearningReports(24);
      if (!state.reports.length) { list.innerHTML = '<div class="training-empty">首份报告会在下月 2 日 00:20 生成。</div>';detail.innerHTML='<div class="training-empty">月报只对本人可见，不会进入公开主页或排行榜。</div>';return; }
      list.innerHTML = state.reports.map((row,index)=>`<button type="button" class="report-month ${index===0?'active':''}" data-report-month="${esc(row.report_month)}"><b>${esc(row.report_month.slice(0,7))}</b><span>${esc(reportTypeText(row.summary?.report_type))}</span><em>${Number(row.summary?.independent_ac||0)} AC · ${Number(row.summary?.active_days||0)} 天</em></button>`).join('');
      $$('[data-report-month]',list).forEach(button=>button.onclick=async()=>{$$('[data-report-month]',list).forEach(item=>item.classList.toggle('active',item===button));await showReport(button.dataset.reportMonth);});
      await showReport(state.reports[0].report_month);
    } catch(error) { list.innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;detail.innerHTML=''; }
  }

  async function showReport(month) {
    const detail=$("#trainingReportDetail");detail.innerHTML='<div class="training-loading">正在翻阅月报……</div>';
    try {
      const report=await api.fetchLearningReport(month);if(!report){detail.innerHTML='<div class="training-empty">没有找到这期报告。</div>';return;}
      const summary=report.summary||{},difficulty=report.difficulty||{},activity=report.activity||{},quality=report.data_quality||{};
      const comparison=summary.comparison||{};const trend=comparison.baseline?'这是第一份基线报告。':`较上月：AC ${Number(comparison.independent_ac_delta||0)>=0?'+':''}${Number(comparison.independent_ac_delta||0)}，活跃天 ${Number(comparison.active_days_delta||0)>=0?'+':''}${Number(comparison.active_days_delta||0)}。`;
      const skillRows=(report.skill_changes||[]).map(item=>`<li><b>${esc(item.region_name)}</b><span>掌握度 ${Number(item.mastery_percent||0)}%，较上月 ${Number(item.mastery_delta||0)>=0?'+':''}${Number(item.mastery_delta||0)}${item.reached_100?' · 本月点亮':item.reached_80?' · 本月达到 80%':''}</span></li>`).join('')||'<li><span>本月暂无可归类的掌握度变化。</span></li>';
      const weakRows=(report.weaknesses||[]).map(item=>`<li><b>${esc(item.name)}</b><span>${Number(item.percent||0)}% · ${esc(item.assessment==='rusty'?'历史较强但需要复习':item.reason||'可靠证据显示仍有缺口')}</span></li>`).join('')||'<li><span>暂无证据充分的弱项；证据不足不会被判作退步。</span></li>';
      const goals=(report.next_month_goals||[]).map(goal=>`<li><b>${esc(goal.region_name||'算法训练')}</b><span>${Number(goal.problem_count||0)} 题 · 建议难度 ${Number(goal.difficulty_min||0)}–${Number(goal.difficulty_max||0)}</span></li>`).join('');
      detail.innerHTML=`<article class="learning-report"><header><div><span>${esc(reportTypeText(summary.report_type))}</span><h3>${esc(report.report_month.slice(0,7))} 学习报告</h3><p>${esc(trend)}</p></div><button class="btn ghost small" id="printLearningReport" type="button">打印报告</button></header><div class="report-metrics"><span><b>${Number(summary.independent_ac||0)}</b>独立 AC</span><span><b>${Number(summary.submissions||0)}</b>提交</span><span><b>${Number(summary.accepted_ratio||0)}%</b>通过提交</span><span><b>${Number(summary.active_days||0)}</b>活跃天</span><span><b>${difficulty.hard_problem_average==null?'—':Math.round(Number(difficulty.hard_problem_average))}</b>高难均值</span><span><b>${difficulty.maximum??'—'}</b>最高难度</span></div><div class="report-columns"><section><h4>本月进步</h4><ul>${skillRows}</ul></section><section><h4>当前不足</h4><ul>${weakRows}</ul></section><section><h4>下月目标</h4><ul>${goals}</ul></section></div><footer><b>数据质量</b><span>难度覆盖 ${Number(quality.difficulty_coverage||0)}% · 可靠标签覆盖 ${Number(quality.reliable_tag_coverage||0)}%</span><small>${esc(quality.warning||`训练风格：${({steady:'稳定训练',burst:'集中突击',mixed:'混合节奏',rest:'休整'})[activity.training_style]||'待观察'}。`)}</small></footer></article>`;
      $("#printLearningReport").onclick=()=>window.print();
    } catch(error){detail.innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;}
  }

  async function renderSettings() {
    if (!api.cloud.user) return;
    $("#trainingBindingCards").innerHTML='<div class="training-loading">正在读取平台绑定……</div>';
    try {
      const data=await api.fetchTrainingDashboard();state.dashboard=data;renderBindingCards(data.accounts||[]);renderPrivacy(data.privacy||{});renderAccountSummary(data);await renderAvatarFrames();
      try { const audit=await api.fetchTrainingAccessAudit(api.cloud.user.id,30);$("#trainingAccessAudit").innerHTML=audit.length?audit.map(row=>`<p><b>@${esc(row.actor_handle)}</b> 于 ${nowText(Date.parse(row.created_at))} 查看了私密热力图</p>`).join(''):'暂无访问记录。'; } catch { $("#trainingAccessAudit").textContent='暂无访问记录。'; }
    } catch(error){$("#trainingBindingCards").innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;}
  }

  async function renderAvatarFrames() {
    const box=$("#avatarFrameCabinet");if(!box)return;
    try { const frames=await api.fetchAvatarFrames();box.innerHTML=frames.map(frame=>`<article class="avatar-frame-card ${frame.unlocked?'unlocked':'locked'} ${frame.equipped?'equipped':''}"><span class="frame-preview ${esc(frame.style_class)}">L</span><div><b>${esc(frame.name)}</b><small>${esc(frame.rarity)} · ${esc(frame.description)}</small></div>${frame.unlocked?`<button class="btn ${frame.equipped?'dark':'ghost'} small" data-equip-frame="${esc(frame.equipped?'':frame.code)}" type="button">${frame.equipped?'取消装备':'装备'}</button>`:'<em>未解锁</em>'}</article>`).join('')||'<div class="training-empty">暂无头像框定义。</div>';$$('[data-equip-frame]',box).forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api.equipAvatarFrame(button.dataset.equipFrame||null);toast(button.dataset.equipFrame?'头像框已装备':'已恢复普通头像');await renderAvatarFrames();}catch(error){toast(error.message,'error');}finally{button.disabled=false;}}); }
    catch(error){box.innerHTML=`<div class="training-empty">${esc(error.message)}</div>`;}
  }

  function renderBindingCards(accounts) {
    $("#trainingBindingCards").innerHTML=Object.entries(platformMeta).map(([platform,meta])=>{const account=accounts.find(item=>item.platform===platform);return account?`<article class="binding-card bound"><div class="binding-platform"><i>${esc(meta.icon)}</i><span><b>${esc(meta.name)}</b><small>@${esc(account.handle)}</small></span></div><p class="binding-status ${esc(account.status)}">${esc(statusText(account.status))}${account.last_success_at?` · ${nowText(Date.parse(account.last_success_at))}`:''}</p>${account.last_error?`<small class="binding-error">${esc(account.last_error)}</small>`:''}<div><button class="btn ghost small" data-sync-platform="${platform}" type="button">立即同步</button><button class="text-btn danger-text" data-unbind-account="${account.id}" type="button">解除绑定</button></div></article>`:`<article class="binding-card"><div class="binding-platform"><i>${esc(meta.icon)}</i><span><b>${esc(meta.name)}</b><small>尚未连接</small></span></div><p>把一次性验证码临时放入 ${esc(meta.field)}，验证后即可删除。</p><div><button class="btn primary small" data-bind-platform="${platform}" type="button">验证绑定</button><button class="text-btn" data-fallback-platform="${platform}" type="button">备用提交验证</button></div></article>`;}).join('');
    $$('[data-bind-platform]').forEach(button=>button.onclick=()=>startBinding(button.dataset.bindPlatform,false));$$('[data-fallback-platform]').forEach(button=>button.onclick=()=>startBinding(button.dataset.fallbackPlatform,true));
    $$('[data-sync-platform]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const result=await api.requestTrainingSync(button.dataset.syncPlatform);toast(result.jobs?.some(job=>job.cooldown)?"仍在冷却期，已显示最近任务":"同步任务已进入队列");await renderSettings();}catch(error){toast(error.message,"error");}finally{button.disabled=false;}});
    $$('[data-unbind-account]').forEach(button=>button.onclick=async()=>{if(!confirm("解除后会停止统计，并删除该平台的已同步提交数据。确定继续吗？"))return;try{await api.trainingBindingAction({action:'unbind',accountId:button.dataset.unbindAccount});toast("平台绑定已解除");await renderSettings();}catch(error){toast(error.message,"error");}});
  }

  async function startBinding(platform, fallback) {
    const meta=platformMeta[platform];const body=await openModal({title:`绑定 ${meta.name}`,html:`<p class="modal-help">只填写公开用户名。Leather 不会要求平台密码、Cookie 或 API Key。</p><label>平台用户名<input id="trainingBindHandle" maxlength="40" autocomplete="off" placeholder="请输入 ${esc(meta.name)} 用户名"></label>`,confirm:fallback?'创建提交挑战':'生成验证码'});if(!body)return;
    const handle=$("#trainingBindHandle",body).value.trim();if(!handle){toast("请填写平台用户名","error");return;}
    try{
      const challenge=await api.trainingBindingAction({action:fallback?'fallback':'start',platform,handle});
      const detail=challenge.method==='profile_code'?`<div class="verification-code">${esc(challenge.code)}</div><p>请临时把验证码放入 <b>${esc(challenge.placement)}</b>，保存公开资料后回到这里验证。验证成功后即可删除验证码。</p>`:`<p>请在有效期内向 <a href="${esc(challenge.challenge.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(challenge.challenge.title)}</b></a> 提交一次编译错误。此方式只检查题目、时间和判题结果，不读取源码。</p>`;
      const verify=await openModal({title:"完成所有权验证",html:`${detail}<small>有效期至 ${new Date(challenge.expiresAt).toLocaleTimeString('zh-CN')}</small>`,confirm:"我已完成，开始验证"});if(!verify)return;
      await api.trainingBindingAction({action:'verify',challengeId:challenge.challengeId});toast("绑定成功，历史记录正在后台回填");await renderSettings();
    }catch(error){toast(error.message,"error");}
  }

  function renderPrivacy(value) {
    $("#privacyAccountsPublic").checked=value.accounts_public!==false;$("#privacyHeatmapPublic").checked=value.heatmap_public!==false;$("#privacyMapPublic").checked=value.map_public!==false;$("#privacyRecentPublic").checked=value.recent_public!==false;
  }

  function renderAccountSummary(data) {
    const box=$("#accountTrainingSummary");if(!box)return;const active=(data.maps||[]).find(map=>map.code===pickActiveMap(data.maps||[]));box.innerHTML=`<div class="account-training-metrics"><span><b>${Number(data.summary?.solved||0)}</b>独立 AC</span><span><b>${Number(data.summary?.active_days||0)}</b>活跃天</span><span><b>${Number(active?.progress||0)}%</b>${esc(active?.name||'启程平原')}</span></div><p>${(data.accounts||[]).length?`已连接 ${(data.accounts||[]).length} 个平台，数据截至 ${data.data_through?nowText(Date.parse(data.data_through)):'等待首次同步'}。`:'尚未绑定竞赛平台。'}</p><a class="btn ghost small" href="#training-world">查看完整地图</a>`;
  }

  async function refreshAccountSummary() { if(!api.cloud.user||!api.cloud.configured)return;try{renderAccountSummary(await api.fetchTrainingDashboard());}catch{$("#accountTrainingSummary").innerHTML='<p>算法远征尚未初始化，请先应用最新数据库迁移。</p>';}}

  function init() {
    if(state.initialized)return;state.initialized=true;
    $("#trainingRefreshBtn").onclick=async()=>{const button=$("#trainingRefreshBtn");button.disabled=true;try{const result=await api.requestTrainingSync();toast(result.jobs?.length?"同步任务已进入队列":"请先在设置页绑定竞赛平台");}catch(error){toast(error.message,"error");}finally{button.disabled=false;}};
    $("#trainingShareBtn").onclick=async()=>{const url=`${location.origin}${location.pathname}#training-world/${encodeURIComponent(state.targetId||api.cloud.user?.id||'')}`;try{await navigator.clipboard.writeText(url);toast("分享链接已复制");}catch{prompt("复制分享链接：",url);}};
    $("#trainingHeatmapRange").onchange=loadHeatmap;$("#trainingHeatmapPlatform").onchange=loadHeatmap;
    $("#trainingRerollBtn").onclick=async()=>{if(!state.own)return;try{await api.requestTrainingSync();toast("同步完成后会重新评估今日路线");}catch(error){toast(error.message,"error");}};
    $("#trainingPrivacyForm").onsubmit=async event=>{event.preventDefault();try{await api.updateTrainingPrivacy({accounts:$("#privacyAccountsPublic").checked,heatmap:$("#privacyHeatmapPublic").checked,map:$("#privacyMapPublic").checked,recent:$("#privacyRecentPublic").checked});toast("算法画像隐私设置已保存");await renderSettings();}catch(error){toast(error.message,"error");}};
  }

  init();
  return { renderWorld, renderSettings, refreshAccountSummary };
}
