/* =========================================================================
   BALANCEADOR ENTRE GRUPOS — Tribal Wars (versão nova)
   -------------------------------------------------------------------------
   Envia recursos das aldeias de um GRUPO DE ORIGEM para as aldeias de um
   GRUPO DE DESTINO.
     • prioriza as aldeias de destino MENORES (menos pontos) — crescem antes
     • prefere a aldeia de ORIGEM mais PRÓXIMA de cada destino
     • nunca ultrapassa o ARMAZÉM do destino (com margem de segurança)
     • respeita os MERCADORES disponíveis em cada origem (1000 por mercador)
   Ele calcula o plano e mostra links de envio já preenchidos (1 clique cada).
   Não dispara envios sozinho — mais seguro contra captcha/regras do mundo.

   COMO USAR (funciona no PC e no MOBILE, sem console)
     1) Hospede este arquivo numa URL HTTPS pública (ex.: GitHub → jsDelivr).
     2) No jogo: Configurações → Barra de acesso rápido (Quickbar) → adicionar
        link. No campo de URL, cole:
          javascript:$.getScript('https://SEU_HOST/balanceador-entre-grupos.js')
     3) Toque no botão na barra de acesso rápido (dentro do jogo, no celular ou
        no PC). Abre um painel na tela: escolha o grupo de origem e o de
        destino, ajuste os %, toque em "Calcular plano" e depois em "Enviar"
        em cada linha.

   IMPORTANTE: confira as regras de scripts do SEU mundo. Só faz leitura +
   monta links; o envio é você que confirma.
   ========================================================================= */
(async function () {
  "use strict";

  // ------------------------- AJUSTES -------------------------
  const CFG = {
    keepPercent: 10,     // % do armazém que a ORIGEM mantém (não esvazia tudo)
    maxFillPercent: 90,  // enche o DESTINO só até esse % do armazém (margem p/ transportes em trânsito)
    minSend: 1000,       // ignora envios menores que isso (1 mercador)
    resources: ["wood", "stone", "iron"], // recursos a balancear
    smallFirst: true,    // priorizar destinos com menos pontos
    onlyResource: null   // "wood" | "stone" | "iron" para balancear só um; null = todos
  };
  // Tabela de capacidade do armazém por nível (fallback, caso a visão geral
  // mostre o NÍVEL em vez da capacidade).
  const WH_CAP = {1:1000,2:1229,3:1512,4:1859,5:2285,6:2810,7:3454,8:4247,9:5222,10:6420,11:7893,12:9705,13:11932,14:14670,15:18037,16:22177,17:27266,18:33523,19:41217,20:50675,21:62305,22:76604,23:94184,24:115798,25:142373,26:175047,27:215219,28:264611,29:325337,30:400000};

  const origin = location.origin;
  const num = s => { const n = parseInt(String(s == null ? "" : s).replace(/[^\d]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ------------------------- LOG DE DEBUG -------------------------
  const LOG = [];
  function log(msg, obj) {
    const line = msg + (obj !== undefined ? " → " + (typeof obj === "object" ? JSON.stringify(obj) : String(obj)) : "");
    LOG.push(line);
    try { console.log("%c[Balanceador]", "color:#e5484d;font-weight:bold", msg, obj !== undefined ? obj : ""); } catch (e) {}
  }

  const fetchDoc = async u => {
    log("fetch", u);
    let resp, txt;
    try {
      resp = await fetch(origin + u, { credentials: "same-origin" });
      log("  status HTTP", resp.status);
      txt = await resp.text();
      log("  bytes recebidos", txt.length);
    } catch (e) {
      log("  ERRO no fetch", e.message);
      return new DOMParser().parseFromString("<html></html>", "text/html");
    }
    const doc = new DOMParser().parseFromString(txt, "text/html");
    log("  tabelas na página", doc.querySelectorAll("table").length);
    log("  <tr> na página", doc.querySelectorAll("tr").length);
    log("  links village= na página", doc.querySelectorAll('a[href*="village="]').length);
    return doc;
  };

  // ------------------------- GRUPOS -------------------------
  async function loadGroups() {
    // Método 1 (novo layout): grupos aparecem como LINKS no topo da visão geral.
    try {
      const doc = await fetchDoc("/game.php?screen=overview_villages&mode=prod&page=-1");
      const seen = {}, out = [];
      // preferir os itens do menu de grupos (data-group-id / classe group-menu-item)
      doc.querySelectorAll('.group-menu-item[data-group-id], a[data-group-id]').forEach(a => {
        const id = String(a.getAttribute("data-group-id") || "").trim();
        if (!id || id === "0" || seen[id]) return;
        const name = (a.textContent || "").replace(/[\[\]<>]/g, "").trim();
        if (!name) return;
        seen[id] = 1; out.push({ id, name });
      });
      // fallback: qualquer link com group= na URL
      if (!out.length) {
        doc.querySelectorAll('a[href*="group="]').forEach(a => {
          const m = a.href.match(/[?&]group=(\d+)/);
          if (!m) return;
          const id = m[1];
          if (id === "0" || seen[id]) return;
          const name = (a.textContent || "").replace(/[\[\]<>]/g, "").trim();
          if (!name) return;
          seen[id] = 1; out.push({ id, name });
        });
      }
      log("grupos encontrados", out.length);
      if (out.length) return out;
      // fallback: seletor <select> (layout antigo)
      const sel = doc.querySelector('#group_id, select[name="group_id"], select.group-select');
      if (sel) {
        const opts = [...sel.querySelectorAll("option")]
          .map(o => ({ id: String(o.value).trim(), name: (o.textContent || "").trim() }))
          .filter(o => o.id && o.id !== "0" && o.name && !/^[-\s]+$/.test(o.name));
        if (opts.length) return opts;
      }
    } catch (e) { log("loadGroups método 1 erro", e.message); }
    // Método 2: ajax load_group_menu (com token CSRF, se disponível).
    try {
      const gd = window.game_data || {};
      const h = gd.csrf || (window.csrf_token || "");
      const r = await fetch(origin + "/game.php?screen=groups&ajax=load_group_menu" + (h ? "&h=" + h : ""), {
        credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest", "TribalWars-Ajax": "1" }
      });
      const j = await r.json();
      const list = (j && j.result) || (j && j.response && j.response.result) || [];
      const out = list
        .map(g => ({ id: String(g.group_id != null ? g.group_id : g[0]), name: (g.name != null ? g.name : g[1]) }))
        .filter(g => g.id && g.id !== "0" && g.name);
      if (out.length) return out;
    } catch (e) { log("loadGroups método 2 erro", e.message); }
    return [];
  }

  // ------------------------- LEITURA DA VISÃO GERAL (PRODUÇÃO) -------------------------
  // Localiza a tabela de aldeias (production_table) e mapeia colunas pelo SEU cabeçalho.
  function findTableAndMap(doc) {
    // 1) tabela oficial da tela Produção
    let table = doc.querySelector("#production_table");
    // 2) senão, a tabela que tem mais linhas com link de aldeia + coordenada
    if (!table) {
      let best = null, bestCount = 0;
      doc.querySelectorAll("table").forEach(t => {
        const c = [...t.querySelectorAll("tr")].filter(tr => tr.querySelector('a[href*="village="]') && /\d{1,3}\|\d{1,3}/.test(tr.textContent || "")).length;
        if (c > bestCount) { bestCount = c; best = t; }
      });
      table = best;
    }
    const map = {};
    if (!table) return { table: null, map };
    // cabeçalho = 1ª linha com <th> dentro DESSA tabela
    const headTr = table.querySelector("thead tr") || [...table.querySelectorAll("tr")].find(tr => tr.querySelector("th"));
    if (headTr) {
      [...headTr.children].forEach((c, i) => {
        const t = (c.textContent || "").toLowerCase();
        if (/pont|point/.test(t)) map.points = i;
        if (/recurso|resource/.test(t)) map.res = i;
        if (/armaz|warehouse|capac|storage/.test(t)) map.storage = i;
        if (/comerciante|mercador|merchant|trader/.test(t)) map.merchants = i;
      });
    }
    return { table, map };
  }
  // extrai os 3 primeiros números de um texto (madeira, argila, ferro), aceitando "80.928"
  function threeNums(txt) {
    const m = (txt || "").match(/\d[\d.,]*\d|\d/g);
    if (!m) return null;
    const nums = m.map(num).filter(n => !isNaN(n));
    if (nums.length < 3) return null;
    return { wood: nums[0], stone: nums[1], iron: nums[2] };
  }
  function readRes(tr, map) {
    // 1) por classe .res.wood/.stone/.iron (layout real da tela Produção do br142)
    const woodEl = tr.querySelector("span.wood, .res.wood");
    const stoneEl = tr.querySelector("span.stone, .res.stone");
    const ironEl = tr.querySelector("span.iron, .res.iron");
    if (woodEl && stoneEl && ironEl) {
      return { wood: num(woodEl.textContent), stone: num(stoneEl.textContent), iron: num(ironEl.textContent) };
    }
    // 2) coluna única "Recursos" com 3 números
    if (map.res != null && tr.children[map.res]) {
      const r = threeNums(tr.children[map.res].textContent);
      if (r) return r;
    }
    // 3) colunas separadas por índice
    if (map.wood != null && map.stone != null && map.iron != null) {
      return { wood: num(tr.children[map.wood].textContent), stone: num(tr.children[map.stone].textContent), iron: num(tr.children[map.iron].textContent) };
    }
    return null;
  }
  function readStorage(tr, map) {
    if (map.storage == null || !tr.children[map.storage]) return null;
    const val = num(tr.children[map.storage].textContent);
    if (val > 0 && val <= 30 && WH_CAP[val]) return WH_CAP[val]; // caso mostre o nível
    return val || null;
  }
  function readMerchants(tr, map) {
    if (map.merchants == null || !tr.children[map.merchants]) return null;
    const m = (tr.children[map.merchants].textContent || "").match(/(\d[\d.]*)/); // "66/110" -> 66
    return m ? num(m[1]) : 0;
  }

  async function readGroup(gid) {
    log("=== readGroup grupo " + gid + " ===");
    const doc = await fetchDoc("/game.php?screen=overview_villages&mode=prod&group=" + gid + "&page=-1");
    const { table, map } = findTableAndMap(doc);
    log("achou production_table?", !!table);
    log("mapa de colunas", map);
    if (!table) {
      log("!! nenhuma tabela de aldeias encontrada");
      return { villages: [], missing: ["tabela"] };
    }
    // linhas de aldeia = <tr> DENTRO da tabela, com link de aldeia E coordenada
    const allTr = [...table.querySelectorAll("tr")];
    const rows = allTr.filter(tr => tr.querySelector('a[href*="village="]') && /\d{1,3}\|\d{1,3}/.test(tr.textContent || ""));
    log("linhas na tabela: total=" + allTr.length + " aldeias=" + rows.length);
    const villages = [];
    const missing = new Set();
    if (map.res == null) missing.add("recursos(coluna)"); // recursos são lidos por classe; isto é só informativo
    if (map.storage == null) missing.add("armazém");
    if (map.merchants == null) missing.add("mercadores");
    let firstLogged = false;
    rows.forEach(tr => {
      const link = tr.querySelector('a[href*="village="]');
      const idm = link.href.match(/village=(\d+)/);
      const mm = (tr.textContent || "").match(/(\d{1,3})\|(\d{1,3})/);
      if (!idm || !mm) return;
      // nome: usa o data-text da label quando existir (evita pegar "Edifício principal" etc.)
      const label = tr.querySelector(".quickedit-label");
      const name = (label && (label.getAttribute("data-text") || label.textContent) || link.textContent || "").trim().replace(/\s*\(\d+\|\d+\).*/, "");
      const v = { id: +idm[1], name: name || ("Aldeia " + idm[1]), x: +mm[1], y: +mm[2] };
      v.points = (map.points != null && tr.children[map.points]) ? num(tr.children[map.points].textContent) : 0;
      const res = readRes(tr, map);
      if (res) { v.wood = res.wood; v.stone = res.stone; v.iron = res.iron; }
      else { v.wood = v.stone = v.iron = 0; }
      v.storage = readStorage(tr, map) || 0;
      const me = readMerchants(tr, map);
      v.merchants = me == null ? 0 : me;
      if (!firstLogged) { log("1ª aldeia lida", { nome: v.name, x: v.x, y: v.y, pts: v.points, w: v.wood, s: v.stone, i: v.iron, arm: v.storage, merc: v.merchants, res_ok: !!res }); firstLogged = true; }
      villages.push(v);
    });
    log("total de aldeias lidas: " + villages.length);
    return { villages, missing: [...missing] };
  }

  // ------------------------- ALGORITMO -------------------------
  function buildPlan(sources, targets) {
    const RES = CFG.onlyResource ? [CFG.onlyResource] : CFG.resources;
    // estado das origens
    const S = sources.map(v => ({
      ...v,
      merchantsLeft: v.merchants,
      surplus: Object.fromEntries(RES.map(r => [r, Math.max(0, v[r] - Math.floor(CFG.keepPercent / 100 * v.storage))]))
    }));
    // estado dos destinos (espaço livre até maxFillPercent)
    const cap = v => Math.floor(CFG.maxFillPercent / 100 * v.storage);
    const T = targets.map(v => ({
      ...v,
      free: Object.fromEntries(RES.map(r => [r, Math.max(0, cap(v) - v[r])]))
    }));
    if (CFG.smallFirst) T.sort((a, b) => a.points - b.points); // menores primeiro

    const sends = []; // {src, dst, wood, stone, iron, merchants, dist}
    for (const dst of T) {
      // origens ordenadas pela distância a este destino
      const near = S.filter(s => s.id !== dst.id).sort((a, b) => dist(a, dst) - dist(b, dst));
      for (const src of near) {
        if (src.merchantsLeft <= 0) continue;
        if (RES.every(r => dst.free[r] <= 0)) break; // destino cheio
        // quanto cada recurso pode ir
        let want = {}; let total = 0;
        RES.forEach(r => { const amt = Math.min(dst.free[r], src.surplus[r]); want[r] = amt; total += amt; });
        if (total < CFG.minSend) continue;
        // limita pelos mercadores da origem
        const maxCarry = src.merchantsLeft * 1000;
        if (total > maxCarry) {
          const f = maxCarry / total;
          RES.forEach(r => { want[r] = Math.floor(want[r] * f); });
          total = RES.reduce((s, r) => s + want[r], 0);
        }
        if (total < CFG.minSend) continue;
        const merchants = Math.ceil(total / 1000);
        // registra e atualiza estado
        const send = { src, dst, merchants, dist: +dist(src, dst).toFixed(1), wood: 0, stone: 0, iron: 0 };
        RES.forEach(r => { send[r] = want[r]; src.surplus[r] -= want[r]; dst.free[r] -= want[r]; });
        src.merchantsLeft -= merchants;
        sends.push(send);
        if (RES.every(r => dst.free[r] <= 0)) break;
      }
    }
    return sends;
  }

  // ------------------------- PAINEL (mobile-friendly) -------------------------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = n => (n || 0).toLocaleString("pt-BR");
  const val = id => { const el = document.getElementById(id); return el ? String(el.value).trim() : ""; };

  function panelBase() {
    document.getElementById("bal-grupos-panel")?.remove();
    const w = document.createElement("div");
    w.id = "bal-grupos-panel";
    w.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:2147483647;width:min(620px,100vw);max-height:92vh;overflow:auto;background:#2b1c10;color:#f0e6d8;border:2px solid #7a5230;border-bottom:none;border-radius:12px 12px 0 0;font:15px/1.5 Verdana,Arial,sans-serif;box-shadow:0 -8px 40px rgba(0,0,0,.6);-webkit-text-size-adjust:100%";
    document.body.appendChild(w);
    return w;
  }
  function headerBar(title, backFn) {
    const back = backFn ? '<span id="bg-back" style="cursor:pointer;font-size:14px;padding:4px 8px;border:1px solid #7a5230;border-radius:6px">‹ trocar grupos</span>' : '<span></span>';
    setTimeout(() => { const b = document.getElementById("bg-back"); if (b && backFn) b.onclick = backFn; }, 0);
    return '<div style="position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#3a2716;padding:12px 14px;border-bottom:1px solid #7a5230">' +
      back + '<b style="font-size:15px">' + title + '</b>' +
      '<span style="cursor:pointer;font-size:20px;padding:0 6px" onclick="document.getElementById(\'bal-grupos-panel\').remove()">✕</span></div>';
  }
  const INP = "width:100%;box-sizing:border-box;font-size:16px;padding:10px;background:#1e130a;color:#f0e6d8;border:1px solid #7a5230;border-radius:8px";
  const LBL = "display:block;font-size:12px;color:#c9a67e;margin:2px 0 4px;text-transform:uppercase;letter-spacing:.05em";
  const BTN = "width:100%;font-size:16px;font-weight:bold;padding:13px;background:#3a7d54;color:#eafff0;border:none;border-radius:8px;cursor:pointer";

  // ---- Tela 1: escolher grupos e ajustes ----
  async function renderSetup() {
    const w = panelBase();
    w.innerHTML = headerBar("Balanceador entre grupos") + '<div style="padding:16px;color:#d8c3a6">Carregando grupos…</div>';
    const groups = await loadGroups();

    const groupField = (id, label) => groups.length
      ? '<label style="' + LBL + '">' + label + '</label><select id="' + id + '" style="' + INP + '">' + groups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join("") + '</select>'
      : '<label style="' + LBL + '">' + label + ' — digite o ID (group=XXXXX na URL do grupo)</label><input id="' + id + '" inputmode="numeric" placeholder="ex.: 12345" style="' + INP + '">';

    w.innerHTML = headerBar("Balanceador entre grupos") +
      '<div style="padding:16px;display:flex;flex-direction:column;gap:14px">' +
        '<div>' + groupField("bg-src", "Grupo de ORIGEM (de onde sai o recurso)") + '</div>' +
        '<div>' + groupField("bg-dst", "Grupo de DESTINO (aldeias pequenas que vão crescer)") + '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:130px"><label style="' + LBL + '">Manter na origem</label><input id="bg-keep" inputmode="numeric" value="' + CFG.keepPercent + '" style="' + INP + '"></div>' +
          '<div style="flex:1;min-width:130px"><label style="' + LBL + '">Encher destino até</label><input id="bg-fill" inputmode="numeric" value="' + CFG.maxFillPercent + '" style="' + INP + '"></div>' +
        '</div>' +
        '<div><label style="' + LBL + '">Recurso</label><select id="bg-res" style="' + INP + '">' +
          [["", "Todos"], ["wood", "Só madeira"], ["stone", "Só argila"], ["iron", "Só ferro"]].map(o => '<option value="' + o[0] + '"' + ((CFG.onlyResource || "") === o[0] ? " selected" : "") + '>' + o[1] + '</option>').join("") + '</select></div>' +
        '<div id="bg-msg" style="color:#ffb4b4;font-size:13px;min-height:0"></div>' +
        '<button id="bg-calc" style="' + BTN + '">Calcular plano</button>' +
        '<div style="color:#b98;font-size:11px">Só lê seus dados e monta os links de envio — você confirma cada envio. Respeite as regras de scripts do seu mundo.</div>' +
      '</div>';

    document.getElementById("bg-calc").onclick = async () => {
      const srcId = val("bg-src"), dstId = val("bg-dst");
      const msg = document.getElementById("bg-msg");
      if (!srcId || !dstId) { msg.textContent = "Escolha os dois grupos."; return; }
      if (srcId === dstId) { msg.textContent = "Origem e destino não podem ser o mesmo grupo."; return; }
      CFG.keepPercent = +val("bg-keep") || CFG.keepPercent;
      CFG.maxFillPercent = +val("bg-fill") || CFG.maxFillPercent;
      CFG.onlyResource = val("bg-res") || null;
      LOG.length = 0;
      log("game_data?", !!window.game_data);
      log("csrf?", (window.game_data && window.game_data.csrf) || window.csrf_token || "NÃO ACHEI");
      log("grupo origem=" + srcId + " destino=" + dstId);
      const btn = document.getElementById("bg-calc");
      btn.textContent = "Lendo aldeias…"; btn.disabled = true;
      const srcInfo = await readGroup(srcId), dstInfo = await readGroup(dstId);
      if (!srcInfo.villages.length || !dstInfo.villages.length) {
        msg.innerHTML = "Não consegui ler aldeias. Origem: " + srcInfo.villages.length + " · Destino: " + dstInfo.villages.length + ".";
        btn.textContent = "Calcular plano"; btn.disabled = false;
        showDebug();
        return;
      }
      const plan = buildPlan(srcInfo.villages, dstInfo.villages);
      renderPlan(plan, srcInfo, dstInfo);
    };
  }

  // Mostra o log de debug num painel copiável.
  function showDebug() {
    let box = document.getElementById("bg-debug");
    if (!box) {
      box = document.createElement("div");
      box.id = "bg-debug";
      box.style.cssText = "margin:0 16px 16px;background:#120a05;border:1px solid #7a5230;border-radius:8px;padding:10px";
      const msg = document.getElementById("bg-msg");
      (msg && msg.parentNode) ? msg.parentNode.appendChild(box) : document.getElementById("bal-grupos-panel").appendChild(box);
    }
    box.innerHTML =
      '<div style="color:#f5a623;font-weight:bold;margin-bottom:6px">Debug (copie e me mande):</div>' +
      '<textarea readonly style="width:100%;box-sizing:border-box;height:180px;background:#0a0603;color:#cbb;border:1px solid #4a331d;border-radius:6px;font-size:11px;font-family:monospace">' +
      esc(LOG.join("\n")) + '</textarea>' +
      '<button id="bg-copylog" style="margin-top:6px;padding:8px 12px;background:#3a2716;color:#f0e6d8;border:1px solid #7a5230;border-radius:6px;cursor:pointer">Copiar log</button>';
    const cp = document.getElementById("bg-copylog");
    if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(LOG.join("\n")); cp.textContent = "Copiado!"; } catch (e) { const t = box.querySelector("textarea"); t.focus(); t.select(); } };
  }

  // ---- Tela 2: plano de envios ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function sendUrl(s) { // fallback (abre a praça preenchida)
    return origin + "/game.php?village=" + s.src.id + "&screen=market&mode=send&target=" + s.dst.id +
      "&wood=" + (s.wood || 0) + "&stone=" + (s.stone || 0) + "&iron=" + (s.iron || 0);
  }
  // ENVIO REAL: usa o endpoint de envio de recursos do jogo (map_send), no
  // contexto da aldeia de origem, com o token de sessão (csrf).
  async function doSend(s, statusEl) {
    statusEl.textContent = "enviando…"; statusEl.style.color = "#e8d9a0";
    const gd = window.game_data || {};
    const csrf = gd.csrf || window.csrf_token || "";
    const url = origin + "/game.php?village=" + s.src.id + "&screen=market&mode=send&ajax=map_send" + (csrf ? "&h=" + csrf : "");
    const body = new URLSearchParams({ target: s.dst.id, x: s.dst.x, y: s.dst.y, wood: s.wood || 0, stone: s.stone || 0, iron: s.iron || 0, h: csrf }).toString();
    try {
      const r = await fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", "TribalWars-Ajax": "1" },
        body
      });
      let j = null, txt = "";
      try { j = await r.clone().json(); } catch (e) { txt = await r.text(); }
      const err = j && (j.error || (j.response && j.response.error));
      if (err) { const m = Array.isArray(err) ? err.join("; ") : String(err); statusEl.textContent = "✗ " + m.slice(0, 70); statusEl.style.color = "#ffb4b4"; console.log("[Balanceador] erro envio:", j); return false; }
      if (r.ok && j) { statusEl.textContent = "enviado ✓"; statusEl.style.color = "#9fe6b8"; return true; }
      // resposta não reconhecida — mostra pra podermos ajustar
      statusEl.textContent = "? resposta inesperada (ver detalhe)";
      statusEl.style.color = "#ffd9a0";
      console.log("[Balanceador] resposta de envio (nao reconhecida):", j || txt.slice(0, 300));
      return false;
    } catch (e) {
      statusEl.textContent = "✗ falha: " + e.message; statusEl.style.color = "#ffb4b4"; return false;
    }
  }

  function renderPlan(sends, srcInfo, dstInfo) {
    const w = panelBase();
    const totMerch = sends.reduce((a, s) => a + s.merchants, 0);
    const tot = { wood: 0, stone: 0, iron: 0 };
    sends.forEach(s => { tot.wood += s.wood; tot.stone += s.stone; tot.iron += s.iron; });

    const missing = [...new Set([...(srcInfo.missing || []), ...(dstInfo.missing || [])])];
    const warn = missing.length
      ? '<div style="background:#5a2b2e;color:#ffd7d7;padding:10px 14px;font-size:13px">⚠ Não achei a(s) coluna(s): <b>' + missing.join(", ") + '</b> na tela de Produção. Me avise pra ajustar.</div>'
      : "";

    let cards = sends.map((s, i) => {
      const parts = [];
      if (s.wood) parts.push("🪵 " + fmt(s.wood));
      if (s.stone) parts.push("🧱 " + fmt(s.stone));
      if (s.iron) parts.push("⚙️ " + fmt(s.iron));
      return '<div style="border-top:1px solid #4a331d;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:170px">' +
          '<div>' + esc(s.src.name) + ' <span style="color:#c9a">(' + s.src.x + '|' + s.src.y + ')</span></div>' +
          '<div style="color:#8fd">↓ ' + s.dist + ' campos · ' + s.merchants + ' merc.</div>' +
          '<div><b>' + esc(s.dst.name) + '</b> <span style="color:#c9a">(' + s.dst.x + '|' + s.dst.y + ')</span> <span style="color:#b98">' + fmt(s.dst.points) + ' pts</span></div>' +
          '<div style="color:#f0e6d8">' + parts.join("  ") + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:96px">' +
          '<button class="bg-send" data-i="' + i + '" style="background:#3a7d54;color:#eafff0;padding:11px 18px;border:none;border-radius:8px;font-weight:bold;font-size:15px;cursor:pointer">Enviar</button>' +
          '<span class="bg-status" data-si="' + i + '" style="font-size:12px;color:#b98;text-align:right;max-width:150px"></span>' +
        '</div>' +
        '</div>';
    }).join("");
    if (!sends.length) cards = '<div style="padding:20px;text-align:center;color:#caa">Nenhum envio necessário — destinos já cheios ou origens sem excedente.</div>';

    const sendAllBtn = sends.length
      ? '<button id="bg-sendall" style="' + BTN + ';margin-top:6px">Enviar todos (' + sends.length + ')</button>'
      : "";

    w.innerHTML = headerBar("Plano de envios", renderSetup) + warn +
      '<div style="padding:12px 14px;color:#d8c3a6;font-size:13px">Origem <b>' + srcInfo.villages.length + '</b> · Destino <b>' + dstInfo.villages.length + '</b> · <b>' + sends.length + '</b> envio(s) · <b>' + totMerch + '</b> mercadores<br>Total: 🪵 ' + fmt(tot.wood) + "  🧱 " + fmt(tot.stone) + "  ⚙️ " + fmt(tot.iron) + '</div>' +
      '<div style="padding:0 14px">' + sendAllBtn + '</div>' +
      cards +
      '<div style="padding:12px 14px;color:#b98;font-size:11px">Cada "Enviar" dispara o envio na hora. Destinos até ' + CFG.maxFillPercent + '% do armazém; origens mantêm ' + CFG.keepPercent + '%.</div>';

    // liga os botões
    const status = i => w.querySelector('.bg-status[data-si="' + i + '"]');
    w.querySelectorAll(".bg-send").forEach(b => {
      b.onclick = async () => {
        const i = +b.dataset.i;
        if (b.dataset.done) return true;
        b.disabled = true; b.style.opacity = ".5";
        const ok = await doSend(sends[i], status(i));
        if (ok) { b.textContent = "enviado ✓"; b.dataset.done = "1"; }
        else { b.disabled = false; b.style.opacity = "1"; b.textContent = "tentar de novo"; }
        return ok;
      };
    });
    const all = w.querySelector("#bg-sendall");
    if (all) all.onclick = async () => {
      all.disabled = true;
      const btns = [...w.querySelectorAll(".bg-send")];
      let done = 0;
      for (const b of btns) {
        if (b.dataset.done) continue;
        all.textContent = "enviando… " + (++done) + "/" + btns.length;
        await b.onclick();
        await sleep(450); // evita disparar rápido demais
      }
      all.textContent = "concluído ✓"; all.disabled = false;
    };
  }

  // ------------------------- EXECUÇÃO -------------------------
  renderSetup();
})();
