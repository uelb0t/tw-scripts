/* =========================================================================
   CONSTRUIR EDIFÍCIO — Tribal Wars (PC e mobile)
   -------------------------------------------------------------------------
   Você escolhe uma ALDEIA DE DESTINO, um EDIFÍCIO e um NÍVEL-ALVO. O script:
     • lê o custo oficial do seu mundo (interface.php?func=get_building_info)
     • lê o nível ATUAL do edifício e os recursos que já existem no destino
     • soma o custo de todos os níveis que faltam até o alvo
     • desconta o que a aldeia já tem
     • puxa o DÉFICIT de um GRUPO de aldeias de origem (mais próximas primeiro),
       respeitando os mercadores de cada origem
     • dispara os envios (mesmo método comprovado do balanceador)

   COMO USAR (quickbar): hospede e adicione no quickbar:
     javascript:$.getScript('https://SEU_HOST/construir-edificio.js')
   ========================================================================= */
(async function () {
  "use strict";

  const CFG = {
    keepPercent: 10,   // % do armazém que a ORIGEM mantém
    extraPercent: 0,   // % a mais de recurso além do custo exato (margem), ex.: 5
    minSend: 1000      // ignora envios menores que isso
  };

  const origin = location.origin;
  const num = s => { const n = parseInt(String(s == null ? "" : s).replace(/[^\d]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = n => (n || 0).toLocaleString("pt-BR");
  const val = id => { const el = document.getElementById(id); return el ? String(el.value).trim() : ""; };
  const LOG = []; const log = (m, o) => { LOG.push(m + (o !== undefined ? " → " + (typeof o === "object" ? JSON.stringify(o) : o) : "")); if (LOG.length > 200) LOG.shift(); };

  // velocidade do mundo (tempo de viagem dos mercadores)
  let WORLD_SPEED = 1;
  async function loadWorldSpeed() {
    try {
      const r = await fetch(origin + "/interface.php?func=get_config", { credentials: "same-origin" });
      const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
      const s = xml.querySelector("speed"); if (s) WORLD_SPEED = parseFloat(s.textContent) || 1;
    } catch (e) {}
  }
  const travelMinutes = f => f * 60 / WORLD_SPEED;
  function fmtDuration(min) { const t = Math.round(min * 60), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60, p = n => String(n).padStart(2, "0"); return (h > 0 ? h + "h" : "") + p(m) + "m" + p(s) + "s"; }
  function arrivalClock(min) { const d = new Date(Date.now() + min * 60000), p = n => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); }

  const fetchDoc = async u => new DOMParser().parseFromString(await (await fetch(origin + u, { credentials: "same-origin" })).text(), "text/html");

  // ------------------------- EDIFÍCIOS (custos oficiais do mundo) -------------------------
  const BUILDING_NAMES = {
    main: "Edifício principal", barracks: "Quartel", stable: "Estábulo", garage: "Oficina",
    watchtower: "Torre de vigia", snob: "Academia", smith: "Ferreiro", place: "Praça de reunião",
    statue: "Estátua", market: "Mercado", wood: "Bosque", stone: "Poço de argila",
    iron: "Mina de ferro", farm: "Fazenda", storage: "Armazém", hide: "Esconderijo",
    wall: "Muralha", church: "Igreja", church_f: "1ª Igreja"
  };
  let BUILD_INFO = null; // { main:{wood,stone,iron,wood_factor,...,max_level}, ... }
  async function loadBuildingInfo() {
    const r = await fetch(origin + "/interface.php?func=get_building_info", { credentials: "same-origin" });
    const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
    const info = {};
    const root = xml.querySelector("config") || xml.documentElement;
    if (!root) return null;
    [...root.children].forEach(node => {
      const key = node.nodeName;
      if (!key || key === "parsererror") return;
      const g = t => { const n = node.querySelector(t); return n ? parseFloat(n.textContent) : null; };
      const wood = g("wood");
      if (wood == null) return; // não é um edifício válido
      info[key] = {
        wood, stone: g("stone"), iron: g("iron"),
        wood_factor: g("wood_factor") || 1, stone_factor: g("stone_factor") || 1, iron_factor: g("iron_factor") || 1,
        max_level: g("max_level"), min_level: g("min_level")
      };
    });
    BUILD_INFO = Object.keys(info).length ? info : null;
    return BUILD_INFO;
  }
  // custo de UM nível: base * fator^(nível-1)
  function levelCost(bkey, level) {
    const b = BUILD_INFO[bkey]; if (!b) return null;
    return {
      wood: Math.round(b.wood * Math.pow(b.wood_factor, level - 1)),
      stone: Math.round(b.stone * Math.pow(b.stone_factor, level - 1)),
      iron: Math.round(b.iron * Math.pow(b.iron_factor, level - 1))
    };
  }
  // custo somado de (atual+1 .. alvo)
  function cumulativeCost(bkey, fromLevel, toLevel) {
    let w = 0, s = 0, i = 0;
    for (let L = fromLevel + 1; L <= toLevel; L++) {
      const c = levelCost(bkey, L); w += c.wood; s += c.stone; i += c.iron;
    }
    const k = 1 + (CFG.extraPercent || 0) / 100;
    return { wood: Math.round(w * k), stone: Math.round(s * k), iron: Math.round(i * k) };
  }

  // ------------------------- LEITURA DE ALDEIAS (produção) -------------------------
  function findTableAndMap(doc) {
    let table = doc.querySelector("#production_table");
    if (!table) { let best = null, bc = 0; doc.querySelectorAll("table").forEach(t => { const c = [...t.querySelectorAll("tr")].filter(tr => tr.querySelector('a[href*="village="]') && /\d{1,3}\|\d{1,3}/.test(tr.textContent || "")).length; if (c > bc) { bc = c; best = t; } }); table = best; }
    const map = {};
    if (!table) return { table: null, map };
    const headTr = table.querySelector("thead tr") || [...table.querySelectorAll("tr")].find(tr => tr.querySelector("th"));
    if (headTr) [...headTr.children].forEach((c, i) => { const t = (c.textContent || "").toLowerCase(); if (/pont|point/.test(t)) map.points = i; if (/recurso|resource/.test(t)) map.res = i; if (/armaz|warehouse|storage/.test(t)) map.storage = i; if (/comerciante|mercador|merchant|trader/.test(t)) map.merchants = i; });
    return { table, map };
  }
  function readRes(tr) { const w = tr.querySelector("span.wood, .res.wood"), c = tr.querySelector("span.stone, .res.stone"), i = tr.querySelector("span.iron, .res.iron"); if (w && c && i) return { wood: num(w.textContent), stone: num(c.textContent), iron: num(i.textContent) }; return null; }
  function readMerch(tr, map) { if (map.merchants == null || !tr.children[map.merchants]) return 0; const m = (tr.children[map.merchants].textContent || "").match(/(\d[\d.]*)/); return m ? num(m[1]) : 0; }

  async function readGroup(gid) {
    const doc = await fetchDoc("/game.php?screen=overview_villages&mode=prod&group=" + gid + "&page=-1");
    const { table, map } = findTableAndMap(doc);
    if (!table) return [];
    const rows = [...table.querySelectorAll("tr")].filter(tr => tr.querySelector('a[href*="village="]') && /\d{1,3}\|\d{1,3}/.test(tr.textContent || ""));
    const villages = [];
    rows.forEach(tr => {
      const link = tr.querySelector('a[href*="village="]');
      const idm = link.href.match(/village=(\d+)/), mm = (tr.textContent || "").match(/(\d{1,3})\|(\d{1,3})/);
      if (!idm || !mm) return;
      const label = tr.querySelector(".quickedit-label");
      const name = (label && (label.getAttribute("data-text") || label.textContent) || link.textContent || "").trim().replace(/\s*\(\d+\|\d+\).*/, "");
      const res = readRes(tr) || { wood: 0, stone: 0, iron: 0 };
      villages.push({ id: +idm[1], name: name || ("Aldeia " + idm[1]), x: +mm[1], y: +mm[2], wood: res.wood, stone: res.stone, iron: res.iron, merchants: readMerch(tr, map) });
    });
    return villages;
  }

  // grupos (links do menu de grupos)
  async function loadGroups() {
    try {
      const doc = await fetchDoc("/game.php?screen=overview_villages&mode=prod&page=-1");
      const seen = {}, out = [];
      doc.querySelectorAll('.group-menu-item[data-group-id], a[data-group-id]').forEach(a => { const id = String(a.getAttribute("data-group-id") || "").trim(); if (!id || id === "0" || seen[id]) return; const nm = (a.textContent || "").replace(/[\[\]<>]/g, "").trim(); if (!nm) return; seen[id] = 1; out.push({ id, name: nm }); });
      if (!out.length) doc.querySelectorAll('a[href*="group="]').forEach(a => { const m = a.href.match(/[?&]group=(\d+)/); if (!m) return; const id = m[1]; if (id === "0" || seen[id]) return; const nm = (a.textContent || "").replace(/[\[\]<>]/g, "").trim(); if (!nm) return; seen[id] = 1; out.push({ id, name: nm }); });
      return out;
    } catch (e) { return []; }
  }

  // nível atual dos edifícios + recursos da aldeia de destino (via game_data da própria aldeia)
  async function readVillageState(vid) {
    // a tela principal (main) traz game_data.village com buildings e recursos atuais
    const doc = await fetchDoc("/game.php?village=" + vid + "&screen=main");
    let gd = null;
    const html = doc.documentElement.innerHTML;
    // tenta várias formas de declaração do game_data
    let m = html.match(/game_data\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) m = html.match(/TribalWars\.updateGameData\((\{[\s\S]*?\})\)/);
    if (m) { try { gd = JSON.parse(m[1]); } catch (e) { log("parse game_data falhou", e.message); } }
    if (gd && gd.village) {
      const v = gd.village;
      return {
        buildings: v.buildings || {},
        wood: Math.floor(v.wood != null ? v.wood : (v.wood_float || 0)),
        stone: Math.floor(v.stone != null ? v.stone : (v.stone_float || 0)),
        iron: Math.floor(v.iron != null ? v.iron : (v.iron_float || 0)),
        storage: v.storage_max, name: v.name, x: v.x, y: v.y
      };
    }
    // fallback: níveis pelas linhas de construção da tela principal
    const buildings = {};
    doc.querySelectorAll('[id^="main_buildrow_"]').forEach(row => {
      const key = row.id.replace("main_buildrow_", "");
      const txt = row.textContent || "";
      const n = txt.match(/(?:vel|lvl|n[íi]vel)\s*(\d+)/i) || txt.match(/(\d+)/);
      buildings[key] = n ? +n[1] : 0;
    });
    log("readVillageState fallback usado", Object.keys(buildings).length);
    return { buildings, wood: 0, stone: 0, iron: 0, storage: 0, name: "", x: 0, y: 0 };
  }

  // ------------------------- ENVIO (método comprovado do balanceador) -------------------------
  async function doSend(s, statusEl) {
    statusEl.textContent = "enviando…"; statusEl.style.color = "#e8d9a0";
    return new Promise(resolve => {
      const data = { target_id: s.dstId, wood: s.wood || 0, stone: s.stone || 0, iron: s.iron || 0 };
      let settled = false; const done = (ok, txt, color) => { if (settled) return; settled = true; statusEl.textContent = txt; statusEl.style.color = color; resolve(ok); };
      try {
        if (!(window.TribalWars && TribalWars.post)) { done(false, "✗ TribalWars.post indisponível", "#ffb4b4"); return; }
        TribalWars.post("market", { ajaxaction: "map_send", village: s.srcId }, data,
          function (resp) { try { if (resp && resp.message && window.UI && UI.SuccessMessage) UI.SuccessMessage(resp.message); } catch (e) {} done(true, "enviado ✓", "#9fe6b8"); },
          false);
        setTimeout(() => done(false, "sem resposta (tente de novo)", "#ffd9a0"), 8000);
      } catch (e) { done(false, "✗ falha: " + e.message, "#ffb4b4"); }
    });
  }

  // ------------------------- PLANO -------------------------
  // aloca o déficit puxando das origens mais próximas do destino, respeitando mercadores
  function buildPlan(sources, target, deficit) {
    const need = { wood: Math.max(0, deficit.wood), stone: Math.max(0, deficit.stone), iron: Math.max(0, deficit.iron) };
    const S = sources.filter(v => v.id !== target.id).map(v => ({ ...v, merchantsLeft: v.merchants, avail: { wood: Math.max(0, v.wood - Math.floor(CFG.keepPercent / 100 * (v.storage || 0))), stone: Math.max(0, v.stone - Math.floor(CFG.keepPercent / 100 * (v.storage || 0))), iron: Math.max(0, v.iron - Math.floor(CFG.keepPercent / 100 * (v.storage || 0))) } }));
    // sem storage lido na origem (produção não traz), usa o recurso todo menos margem fixa
    S.forEach(s => { if (!s.storage) s.avail = { wood: s.wood, stone: s.stone, iron: s.iron }; });
    S.sort((a, b) => dist(a, target) - dist(b, target)); // mais próximas primeiro
    const sends = [];
    const RES = ["wood", "stone", "iron"];
    for (const src of S) {
      if (RES.every(r => need[r] <= 0)) break;
      if (src.merchantsLeft <= 0) continue;
      let want = { wood: 0, stone: 0, iron: 0 }, total = 0;
      RES.forEach(r => { const amt = Math.min(need[r], src.avail[r]); want[r] = amt; total += amt; });
      if (total <= 0) continue;
      const maxCarry = src.merchantsLeft * 1000;
      if (total > maxCarry) { const f = maxCarry / total; RES.forEach(r => want[r] = Math.floor(want[r] * f)); total = RES.reduce((s, r) => s + want[r], 0); }
      if (total < CFG.minSend) continue;
      const merchants = Math.ceil(total / 1000), d = dist(src, target);
      sends.push({ srcId: src.id, srcName: src.name, sx: src.x, sy: src.y, dstId: target.id, wood: want.wood, stone: want.stone, iron: want.iron, merchants, dist: +d.toFixed(1), minutes: travelMinutes(d) });
      RES.forEach(r => { need[r] -= want[r]; src.avail[r] -= want[r]; });
      src.merchantsLeft -= merchants;
    }
    return { sends, remaining: need };
  }

  // ------------------------- UI -------------------------
  function panelBase() {
    document.getElementById("bld-panel")?.remove();
    const w = document.createElement("div"); w.id = "bld-panel";
    w.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:2147483647;width:min(620px,100vw);max-height:92vh;overflow:auto;background:#2b1c10;color:#f0e6d8;border:2px solid #7a5230;border-bottom:none;border-radius:12px 12px 0 0;font:15px/1.5 Verdana,Arial,sans-serif;box-shadow:0 -8px 40px rgba(0,0,0,.6);-webkit-text-size-adjust:100%";
    document.body.appendChild(w); return w;
  }
  function headerBar(title, backFn) {
    const back = backFn ? '<span id="bld-back" style="cursor:pointer;font-size:14px;padding:4px 8px;border:1px solid #7a5230;border-radius:6px">‹ voltar</span>' : '<span></span>';
    setTimeout(() => { const b = document.getElementById("bld-back"); if (b && backFn) b.onclick = backFn; }, 0);
    return '<div style="position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#3a2716;padding:12px 14px;border-bottom:1px solid #7a5230">' + back + '<b style="font-size:15px">' + title + '</b><span style="cursor:pointer;font-size:20px;padding:0 6px" onclick="document.getElementById(\'bld-panel\').remove()">✕</span></div>';
  }
  const INP = "width:100%;box-sizing:border-box;font-size:16px;padding:10px;background:#1e130a;color:#f0e6d8;border:1px solid #7a5230;border-radius:8px";
  const LBL = "display:block;font-size:12px;color:#c9a67e;margin:2px 0 4px;text-transform:uppercase;letter-spacing:.05em";
  const BTN = "width:100%;font-size:16px;font-weight:bold;padding:13px;background:#3a7d54;color:#eafff0;border:none;border-radius:8px;cursor:pointer";

  let SRC_GROUP = null, DST_GROUP = null, GROUP_VILLAGES_CACHE = {};

  async function renderSetup() {
    const w = panelBase();
    w.innerHTML = headerBar("Construir edifício") + '<div style="padding:16px;color:#d8c3a6">Carregando dados do mundo…</div>';
    await Promise.all([loadWorldSpeed(), loadBuildingInfo().catch(e => log("buildinfo erro", e.message))]);
    const groups = await loadGroups();
    if (!BUILD_INFO) { w.innerHTML = headerBar("Construir edifício") + '<div style="padding:16px;color:#ffb4b4">Não consegui ler os custos dos edifícios (interface.php?func=get_building_info). Tente novamente.</div>'; return; }

    const groupOpts = groups.length ? groups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join("") : "";
    const groupField = (id, label) => groups.length
      ? '<label style="' + LBL + '">' + label + '</label><select id="' + id + '" style="' + INP + '">' + groupOpts + '</select>'
      : '<label style="' + LBL + '">' + label + ' (ID do grupo)</label><input id="' + id + '" inputmode="numeric" placeholder="group=XXXXX" style="' + INP + '">';

    // edifícios disponíveis (os que têm custo no mundo)
    const bldOpts = Object.keys(BUILD_INFO).filter(k => BUILD_INFO[k] && BUILD_INFO[k].wood != null)
      .map(k => '<option value="' + k + '">' + esc(BUILDING_NAMES[k] || k) + '</option>').join("");

    w.innerHTML = headerBar("Construir edifício") +
      '<div style="padding:16px;display:flex;flex-direction:column;gap:14px">' +
        '<div>' + groupField("bld-dstgroup", "Grupo onde está a aldeia de DESTINO") + '</div>' +
        '<div><label style="' + LBL + '">Aldeia de destino</label><select id="bld-dst" style="' + INP + '"><option value="">— carregando… —</option></select></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<div style="flex:2;min-width:160px"><label style="' + LBL + '">Edifício</label><select id="bld-building" style="' + INP + '">' + bldOpts + '</select></div>' +
          '<div style="flex:1;min-width:90px"><label style="' + LBL + '">Nível-alvo</label><input id="bld-level" inputmode="numeric" placeholder="ex.: 20" style="' + INP + '"></div>' +
        '</div>' +
        '<div>' + groupField("bld-srcgroup", "Grupo de ORIGEM (de onde puxar recursos)") + '</div>' +
        '<div id="bld-msg" style="color:#ffb4b4;font-size:13px"></div>' +
        '<button id="bld-calc" style="' + BTN + '">Calcular envios</button>' +
        '<div style="color:#b98;font-size:11px">Lê o custo oficial do mundo, desconta o que a aldeia já tem, e puxa o resto das origens mais próximas. Você confirma cada envio.</div>' +
      '</div>';

    // carregar aldeias do grupo de destino no seletor de aldeia
    async function fillDstVillages() {
      const gid = val("bld-dstgroup"); const sel = document.getElementById("bld-dst");
      if (!gid) { sel.innerHTML = '<option value="">— escolha o grupo —</option>'; return; }
      sel.innerHTML = '<option value="">— carregando… —</option>';
      const vs = GROUP_VILLAGES_CACHE[gid] || (GROUP_VILLAGES_CACHE[gid] = await readGroup(gid));
      sel.innerHTML = vs.length ? vs.map(v => '<option value="' + v.id + '">' + esc(v.name) + ' (' + v.x + '|' + v.y + ')</option>').join("") : '<option value="">— nenhuma aldeia —</option>';
    }
    const dg = document.getElementById("bld-dstgroup");
    if (dg) { dg.onchange = fillDstVillages; if (groups.length) fillDstVillages(); }

    document.getElementById("bld-calc").onclick = async () => {
      const msg = document.getElementById("bld-msg");
      const dstGroup = val("bld-dstgroup"), srcGroup = val("bld-srcgroup");
      const dstId = val("bld-dst"), bkey = val("bld-building"), level = parseInt(val("bld-level"), 10);
      if (!dstId) { msg.textContent = "Escolha a aldeia de destino."; return; }
      if (!bkey || !level) { msg.textContent = "Escolha o edifício e o nível-alvo."; return; }
      if (!srcGroup) { msg.textContent = "Escolha o grupo de origem."; return; }
      const bmax = BUILD_INFO[bkey].max_level;
      if (bmax && level > bmax) { msg.textContent = "Nível máximo de " + (BUILDING_NAMES[bkey] || bkey) + " é " + bmax + "."; return; }
      const btn = document.getElementById("bld-calc"); btn.disabled = true; btn.textContent = "Lendo aldeia de destino…";

      const state = await readVillageState(dstId);
      const current = (state.buildings && state.buildings[bkey] != null) ? parseInt(state.buildings[bkey]) : 0;
      if (level <= current) { msg.textContent = (BUILDING_NAMES[bkey] || bkey) + " já está no nível " + current + " (>= alvo)."; btn.disabled = false; btn.textContent = "Calcular envios"; return; }

      const cost = cumulativeCost(bkey, current, level);
      const have = { wood: state.wood || 0, stone: state.stone || 0, iron: state.iron || 0 };
      const deficit = { wood: cost.wood - have.wood, stone: cost.stone - have.stone, iron: cost.iron - have.iron };

      btn.textContent = "Lendo grupo de origem…";
      const sources = GROUP_VILLAGES_CACHE[srcGroup] || (GROUP_VILLAGES_CACHE[srcGroup] = await readGroup(srcGroup));
      const dstV = { id: +dstId, x: state.x, y: state.y, name: state.name };
      // se o game_data não trouxe coords, pega do grupo de destino
      if (!dstV.x) { const dv = (GROUP_VILLAGES_CACHE[dstGroup] || []).find(v => v.id === +dstId); if (dv) { dstV.x = dv.x; dstV.y = dv.y; dstV.name = dstV.name || dv.name; } }

      const { sends, remaining } = buildPlan(sources, dstV, deficit);
      renderPlan({ bkey, current, level, cost, have, deficit, state: dstV, sends, remaining });
    };
  }

  function renderPlan(ctx) {
    const w = panelBase();
    const { bkey, current, level, cost, have, deficit, state, sends, remaining } = ctx;
    const bname = BUILDING_NAMES[bkey] || bkey;
    const totMerch = sends.reduce((a, s) => a + s.merchants, 0);
    const falta = { wood: Math.max(0, remaining.wood), stone: Math.max(0, remaining.stone), iron: Math.max(0, remaining.iron) };
    const faltaAlgo = falta.wood + falta.stone + falta.iron > 0;

    const resumo =
      '<div style="padding:12px 14px;color:#d8c3a6;font-size:13px;border-bottom:1px solid #4a331d">' +
        '<div><b>' + esc(state.name || ("Aldeia " + state.id)) + '</b> (' + state.x + '|' + state.y + ')</div>' +
        '<div>' + esc(bname) + ': nível <b>' + current + '</b> → <b>' + level + '</b></div>' +
        '<div style="margin-top:6px">Custo total: 🪵 ' + fmt(cost.wood) + '  🧱 ' + fmt(cost.stone) + '  ⚙️ ' + fmt(cost.iron) + '</div>' +
        '<div>Já na aldeia: 🪵 ' + fmt(have.wood) + '  🧱 ' + fmt(have.stone) + '  ⚙️ ' + fmt(have.iron) + '</div>' +
        '<div style="color:#ffd9a0">Falta enviar: 🪵 ' + fmt(Math.max(0, deficit.wood)) + '  🧱 ' + fmt(Math.max(0, deficit.stone)) + '  ⚙️ ' + fmt(Math.max(0, deficit.iron)) + '</div>' +
      '</div>';

    let cards = sends.map((s, i) => {
      const parts = []; if (s.wood) parts.push("🪵 " + fmt(s.wood)); if (s.stone) parts.push("🧱 " + fmt(s.stone)); if (s.iron) parts.push("⚙️ " + fmt(s.iron));
      const tempo = s.minutes != null ? fmtDuration(s.minutes) + " · chega " + arrivalClock(s.minutes) : "";
      return '<div class="bld-card" data-card="' + i + '" style="border-top:1px solid #4a331d;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:170px">' +
          '<div>' + esc(s.srcName) + ' <span style="color:#c9a">(' + s.sx + '|' + s.sy + ')</span></div>' +
          '<div style="color:#8fd">↓ ' + s.dist + ' campos · ' + s.merchants + ' merc.' + (tempo ? ' · ⏱ ' + tempo : '') + '</div>' +
          '<div style="color:#f0e6d8">' + parts.join("  ") + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:96px">' +
          '<button class="bld-send" data-i="' + i + '" style="background:#3a7d54;color:#eafff0;padding:11px 18px;border:none;border-radius:8px;font-weight:bold;font-size:15px;cursor:pointer">Enviar</button>' +
          '<span class="bld-status" data-si="' + i + '" style="font-size:12px;color:#b98;text-align:right;max-width:150px"></span>' +
        '</div>' +
        '</div>';
    }).join("");
    if (!sends.length) cards = '<div style="padding:20px;text-align:center;color:#9fe6b8">A aldeia já tem recursos suficientes — nada a enviar. 🎉</div>';

    const faltaMsg = faltaAlgo ? '<div style="background:#5a2b2e;color:#ffd7d7;padding:10px 14px;font-size:13px">⚠ Origens não têm o bastante. Ainda falta: 🪵 ' + fmt(falta.wood) + '  🧱 ' + fmt(falta.stone) + '  ⚙️ ' + fmt(falta.iron) + '</div>' : "";
    const sendAllBtn = sends.length ? '<button id="bld-sendall" style="' + BTN + ';margin-top:6px">Enviar todos (' + sends.length + ')</button>' : "";

    w.innerHTML = headerBar("Plano de construção", renderSetup) + resumo +
      '<div style="padding:10px 14px 0;color:#d8c3a6;font-size:13px"><b>' + sends.length + '</b> envio(s) · <b>' + totMerch + '</b> mercadores</div>' +
      faltaMsg + '<div style="padding:8px 14px 0">' + sendAllBtn + '</div>' +
      '<div id="bld-cards">' + cards + '</div>' +
      '<div style="padding:12px 14px;color:#b98;font-size:11px">Cada "Enviar" dispara na hora e some da lista quando confirmado. ⏱ = tempo dos mercadores.</div>';

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const status = i => w.querySelector('.bld-status[data-si="' + i + '"]');
    const all = w.querySelector("#bld-sendall");
    function refreshCount() { const n = w.querySelectorAll(".bld-card").length; if (all) { all.textContent = n ? "Enviar todos (" + n + ")" : "concluído ✓"; if (!n) all.style.display = "none"; } }
    function removeCard(i) { const c = w.querySelector('.bld-card[data-card="' + i + '"]'); if (c) { c.style.transition = "opacity .25s"; c.style.opacity = "0"; setTimeout(() => { c.remove(); refreshCount(); }, 250); } }
    w.querySelectorAll(".bld-send").forEach(b => {
      b.onclick = async () => {
        const i = +b.dataset.i; if (b.dataset.done) return true;
        b.disabled = true; b.style.opacity = ".5";
        const ok = await doSend(sends[i], status(i));
        if (ok) { b.dataset.done = "1"; removeCard(i); } else { b.disabled = false; b.style.opacity = "1"; b.textContent = "tentar de novo"; }
        return ok;
      };
    });
    if (all) all.onclick = async () => { all.disabled = true; for (const b of [...w.querySelectorAll(".bld-send")]) { if (b.dataset.done) continue; await b.onclick(); await sleep(450); } all.disabled = false; refreshCount(); };
  }

  renderSetup();
})();
