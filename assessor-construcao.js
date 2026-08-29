/* =========================================================================
   ASSESSOR DE CONSTRUÇÃO — Tribal Wars (PC e mobile)
   -------------------------------------------------------------------------
   Roda na tela do EDIFÍCIO PRINCIPAL (screen=main). Analisa a aldeia e diz
   o que enfileirar AGORA, com a filosofia de nunca ficar ocioso:
     • prioriza o edifício MAIS BARATO que você já consegue pagar (fila anda)
     • a FAZENDA fura a fila quando a população livre cai abaixo de um % (padrão 5%)
     • mostra o que dá pra pagar agora, o que falta pra cada opção e em quanto
       tempo você terá recurso pra ela
   Você decide: cada sugestão tem um botão "Enfileirar" (opcional). O foco é
   dar o insight; a ação é sua.

   USO (quickbar), estando na tela do Edifício Principal:
     javascript:$.getScript('https://SEU_HOST/assessor-construcao.js')
   ========================================================================= */
(function () {
  "use strict";

  const CFG = {
    farmFreePct: 5,       // fura a fila pra fazenda quando população livre < 5%
    maxShow: 8,           // quantas recomendações listar
    useModel: true,       // true = só sugere o que ainda falta pro modelo abaixo
    // MODELO DE ALDEIA (níveis-alvo). Edite à vontade. 0 = não construir.
    model: {
      wood: 30, stone: 30, iron: 30,   // bosque, poço de argila, mina de ferro
      farm: 30, storage: 30,           // fazenda, armazém
      main: 20, market: 20, garage: 5, // ed. principal, mercado, oficina
      barracks: 25, stable: 20,        // quartel, estábulo
      smith: 20, wall: 20,             // ferreiro, muralha
      place: 1, statue: 1,             // praça, estátua
      watchtower: 0, hide: 0           // torre (situacional), esconderijo
      // snob (academia) fica de fora do modelo — construa quando for nobre
    }
  };

  const NAMES = {
    main: "Edifício principal", barracks: "Quartel", stable: "Estábulo", garage: "Oficina",
    watchtower: "Torre de vigia", snob: "Academia", smith: "Ferreiro", place: "Praça de reunião",
    statue: "Estátua", market: "Mercado", wood: "Bosque", stone: "Poço de argila",
    iron: "Mina de ferro", farm: "Fazenda", storage: "Armazém", hide: "Esconderijo", wall: "Muralha"
  };

  const gd = window.game_data;
  if (!gd || !gd.village) { alert("Abra a tela do Edifício Principal (screen=main) e rode de novo."); return; }
  const origin = location.origin;
  const fmt = n => Math.round(n || 0).toLocaleString("pt-BR");

  // recursos e produção atuais (game_data traz float + produção por segundo)
  const V = gd.village;
  const res = {
    wood: Math.floor(V.wood_float != null ? V.wood_float : V.wood),
    stone: Math.floor(V.stone_float != null ? V.stone_float : V.stone),
    iron: Math.floor(V.iron_float != null ? V.iron_float : V.iron)
  };
  const prod = { wood: V.wood_prod || 0, stone: V.stone_prod || 0, iron: V.iron_prod || 0 }; // por segundo
  const storageMax = V.storage_max || 0;
  const popMax = V.pop_max || 0, pop = V.pop || 0, popFree = Math.max(0, popMax - pop);
  const popFreePct = popMax ? (popFree / popMax * 100) : 100;
  const levels = V.buildings || {};

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    const p = n => String(n).padStart(2, "0");
    return (d ? d + "d " : "") + p(h) + ":" + p(m) + ":" + p(s);
  }
  // tempo até ter recurso suficiente para um custo (considera produção; para se armazém não comporta)
  function timeToAfford(cost) {
    let worst = 0;
    for (const r of ["wood", "stone", "iron"]) {
      const falta = cost[r] - res[r];
      if (falta <= 0) continue;
      if (cost[r] > storageMax) return Infinity;   // nem cabe no armazém
      if (!prod[r]) return Infinity;
      worst = Math.max(worst, falta / prod[r]);
    }
    return worst;
  }

  // -------- custos oficiais do mundo --------
  async function loadBuildingInfo() {
    const r = await fetch(origin + "/interface.php?func=get_building_info", { credentials: "same-origin" });
    const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
    const root = xml.querySelector("config") || xml.documentElement;
    const info = {};
    [...root.children].forEach(node => {
      const g = t => { const n = node.querySelector(t); return n ? parseFloat(n.textContent) : null; };
      const wood = g("wood"); if (wood == null) return;
      info[node.nodeName] = {
        wood, stone: g("stone"), iron: g("iron"),
        wf: g("wood_factor") || 1, sf: g("stone_factor") || 1, iff: g("iron_factor") || 1,
        pop: g("pop") || 0, pop_factor: g("pop_factor") || 1,
        max_level: g("max_level"), min_level: g("min_level")
      };
    });
    return info;
  }
  function costOf(info, key, level) {
    const b = info[key];
    return {
      wood: Math.round(b.wood * Math.pow(b.wf, level - 1)),
      stone: Math.round(b.stone * Math.pow(b.sf, level - 1)),
      iron: Math.round(b.iron * Math.pow(b.iff, level - 1))
    };
  }
  const canAfford = c => res.wood >= c.wood && res.stone >= c.stone && res.iron >= c.iron;
  const totalCost = c => c.wood + c.stone + c.iron;

  // -------- enfileirar (opcional; usa a API nativa da tela main) --------
  function enqueue(key, statusEl) {
    try {
      if (window.BuildingMain && typeof BuildingMain.build === "function") {
        BuildingMain.build(key); // botão nativo de upar 1 nível
        statusEl.textContent = "enfileirado ✓"; statusEl.style.color = "#9fe6b8";
        setTimeout(() => location.reload(), 900);
        return;
      }
      // fallback: clica no botão nativo de upgrade daquele edifício
      const btn = document.querySelector('#main_buildlink_' + key + '_1, a.btn-build[data-building="' + key + '"], #build_link_' + key);
      if (btn) { btn.click(); statusEl.textContent = "enfileirado ✓"; statusEl.style.color = "#9fe6b8"; setTimeout(() => location.reload(), 900); return; }
      statusEl.textContent = "clique no botão do jogo"; statusEl.style.color = "#ffd9a0";
    } catch (e) { statusEl.textContent = "erro: " + e.message; statusEl.style.color = "#ffb4b4"; }
  }

  // -------- análise --------
  async function analyze() {
    const info = await loadBuildingInfo();
    const cands = [];
    let modelDone = true, totalCur = 0, totalTarget = 0;
    for (const key in info) {
      const cur = parseInt(levels[key] || 0);
      const b = info[key];
      // alvo: do modelo (se ligado) ou o máximo do edifício
      let target = CFG.useModel ? (CFG.model[key] != null ? CFG.model[key] : 0) : (b.max_level || 0);
      if (b.max_level) target = Math.min(target, b.max_level);
      if (CFG.useModel) { totalCur += Math.min(cur, target); totalTarget += target; }
      if (target <= 0 || cur >= target) continue; // já atingiu o alvo (ou não faz parte do modelo)
      modelDone = false;
      const next = cur + 1;
      const cost = costOf(info, key, next);
      cands.push({
        key, name: NAMES[key] || key, cur, next, target, cost,
        total: totalCost(cost), afford: canAfford(cost), wait: timeToAfford(cost)
      });
    }
    const farm = cands.find(c => c.key === "farm");
    const farmUrgent = farm && popFreePct < CFG.farmFreePct && farm.afford;

    const affordable = cands.filter(c => c.afford).sort((a, b) => a.total - b.total);
    const waiting = cands.filter(c => !c.afford && c.wait !== Infinity).sort((a, b) => a.wait - b.wait);

    const progress = totalTarget ? Math.round(totalCur / totalTarget * 100) : 100;
    render({ affordable, waiting, farm, farmUrgent, info, modelDone, progress, remainingCount: cands.length });
  }

  // -------- UI --------
  function panel() {
    document.getElementById("ac-panel")?.remove();
    const w = document.createElement("div"); w.id = "ac-panel";
    w.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:2147483647;width:min(640px,100vw);max-height:92vh;overflow:auto;background:#241811;color:#f0e6d8;border:2px solid #7a5230;border-bottom:none;border-radius:12px 12px 0 0;font:15px/1.5 Verdana,Arial,sans-serif;box-shadow:0 -8px 40px rgba(0,0,0,.6);-webkit-text-size-adjust:100%";
    document.body.appendChild(w); return w;
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function row(c, tag) {
    const parts = [];
    parts.push((c.cost.wood > res.wood ? '<span style="color:#e5877d">' : '<span>') + "🪵 " + fmt(c.cost.wood) + "</span>");
    parts.push((c.cost.stone > res.stone ? '<span style="color:#e5877d">' : '<span>') + "🧱 " + fmt(c.cost.stone) + "</span>");
    parts.push((c.cost.iron > res.iron ? '<span style="color:#e5877d">' : '<span>') + "⚙️ " + fmt(c.cost.iron) + "</span>");
    const right = c.afford
      ? '<button class="ac-build" data-key="' + c.key + '" style="background:#3a7d54;color:#eafff0;padding:9px 16px;border:none;border-radius:8px;font-weight:bold;font-size:14px;cursor:pointer">Enfileirar</button>'
      : '<span style="color:#e8c98a;font-size:13px;white-space:nowrap">em ' + fmtDur(c.wait) + '</span>';
    return '<div style="border-top:1px solid #4a331d;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      (tag ? '<span style="background:' + tag.bg + ';color:' + tag.fg + ';font-size:10px;font-weight:bold;padding:2px 7px;border-radius:20px">' + tag.txt + '</span> ' : '') +
      '<div style="flex:1;min-width:160px"><b>' + esc(c.name) + '</b> <span style="color:#c9a">nv ' + c.cur + '→' + c.next + '</span>' + (c.target ? ' <span style="color:#8a7;font-size:12px">(alvo ' + c.target + ')</span>' : '') + '<br>' +
      '<span style="font-size:13px">' + parts.join("  ") + '</span></div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:96px">' + right +
      '<span class="ac-status" data-si="' + c.key + '" style="font-size:12px;color:#b98"></span></div></div>';
  }

  function render(a) {
    const w = panel();
    const prodStr = "🪵 " + fmt(prod.wood * 3600) + "/h  🧱 " + fmt(prod.stone * 3600) + "/h  ⚙️ " + fmt(prod.iron * 3600) + "/h";
    let html = '<div style="position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#3a2716;padding:12px 14px;border-bottom:1px solid #7a5230"><b>Assessor de construção</b><span style="cursor:pointer;font-size:20px" onclick="document.getElementById(\'ac-panel\').remove()">✕</span></div>';

    html += '<div style="padding:12px 14px;color:#d8c3a6;font-size:13px;border-bottom:1px solid #4a331d">' +
      '<div><b>' + esc(V.name) + '</b> (' + V.x + '|' + V.y + ')</div>' +
      '<div>Recursos: 🪵 ' + fmt(res.wood) + '  🧱 ' + fmt(res.stone) + '  ⚙️ ' + fmt(res.iron) + ' <span style="color:#8a7">/ ' + fmt(storageMax) + '</span></div>' +
      '<div style="color:#9ab">Produção: ' + prodStr + '</div>' +
      '<div>População livre: <b style="color:' + (popFreePct < CFG.farmFreePct ? "#e5877d" : "#9fe6b8") + '">' + fmt(popFree) + '</b> de ' + fmt(popMax) + ' (' + popFreePct.toFixed(1) + '%)</div>' +
      (CFG.useModel ? '<div style="margin-top:8px">Progresso do modelo: <b>' + a.progress + '%</b> · faltam <b>' + a.remainingCount + '</b> edifício(s)' +
        '<div style="height:8px;background:#3a2716;border-radius:5px;margin-top:4px;overflow:hidden"><div style="height:100%;width:' + a.progress + '%;background:#3a7d54"></div></div></div>' : '') +
      '</div>';

    if (a.modelDone) {
      html += '<div style="margin:14px;padding:16px;background:#123021;border:1px solid #2f7d54;border-radius:10px;text-align:center;color:#9fe6b8"><b>🎉 Modelo completo!</b><br>Todos os edifícios atingiram os níveis-alvo.</div>';
      html += '<div style="padding:0 14px 14px;color:#b98;font-size:11px">Edite os alvos em CFG.model se quiser ir além.</div>';
      w.innerHTML = html;
      return;
    }

    // Destaque de recomendação
    let topPick = null, reason = "";
    if (a.farmUrgent) { topPick = a.farm; reason = "População quase cheia (< " + CFG.farmFreePct + "%) — suba a fazenda primeiro."; }
    else if (a.affordable.length) { topPick = a.affordable[0]; reason = "Mais barato que dá pra pagar agora — mantém a fila andando."; }

    if (topPick) {
      html += '<div style="margin:12px 14px;padding:12px;background:#123021;border:1px solid #2f7d54;border-radius:10px">' +
        '<div style="color:#9fe6b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:bold;margin-bottom:4px">▶ Recomendado agora</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div><b style="font-size:16px">' + esc(topPick.name) + '</b> <span style="color:#c9a">nv ' + topPick.cur + '→' + topPick.next + '</span><br><span style="font-size:12px;color:#b98">' + reason + '</span></div>' +
        '<button class="ac-build" data-key="' + topPick.key + '" style="background:#3a7d54;color:#eafff0;padding:11px 20px;border:none;border-radius:8px;font-weight:bold;font-size:15px;cursor:pointer">Enfileirar</button>' +
        '</div><span class="ac-status" data-si="' + topPick.key + '" style="font-size:12px;color:#b98"></span></div>';
    } else {
      html += '<div style="margin:12px 14px;padding:12px;background:#3a2716;border-radius:10px;color:#e8c98a">Nada pagável agora. Veja abaixo o que fica pronto primeiro.</div>';
    }

    if (a.farm && !a.farmUrgent) {
      const f = a.farm;
      html += '<div style="padding:4px 14px;color:#b98;font-size:12px">Fazenda: nv ' + f.cur + ' · população livre ' + popFreePct.toFixed(1) + '% (fura a fila abaixo de ' + CFG.farmFreePct + '%).</div>';
    }

    if (a.affordable.length) {
      html += '<div style="padding:10px 14px 2px;color:#9fe6b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Dá pra pagar agora (mais barato → rumo ao modelo)</div>';
      a.affordable.slice(0, CFG.maxShow).forEach(c => { html += row(c, c.key === "farm" ? { txt: "POP", bg: "#123021", fg: "#9fe6b8" } : null); });
    }
    if (a.waiting.length) {
      html += '<div style="padding:12px 14px 2px;color:#e8c98a;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Esperando recurso (fica pronto em…)</div>';
      a.waiting.slice(0, CFG.maxShow).forEach(c => { html += row(c); });
    }
    html += '<div style="padding:12px 14px;color:#b98;font-size:11px">Só aparecem edifícios abaixo do alvo do modelo. Vermelho = recurso que falta. "Enfileirar" usa o botão nativo do jogo. Edite alvos e o gatilho da fazenda no CFG.</div>';

    w.innerHTML = html;
    w.querySelectorAll(".ac-build").forEach(b => {
      b.onclick = () => { const st = w.querySelector('.ac-status[data-si="' + b.dataset.key + '"]'); b.disabled = true; b.style.opacity = ".5"; enqueue(b.dataset.key, st || document.createElement("span")); };
    });
  }

  analyze().catch(e => alert("Erro no assessor: " + e.message));
})();
