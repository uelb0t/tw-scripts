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

  // Velocidade do mundo (para o tempo de viagem dos mercadores). O mercador anda
  // a 60 min/campo em velocidade 1; tempo = distância * 60 / worldSpeed (minutos).
  let WORLD_SPEED = 1;
  async function loadWorldSpeed() {
    try {
      const r = await fetch(origin + "/interface.php?func=get_config", { credentials: "same-origin" });
      const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
      const s = xml.querySelector("speed");
      if (s) WORLD_SPEED = parseFloat(s.textContent) || 1;
    } catch (e) {}
  }
  function travelMinutes(fields) { return fields * 60 / WORLD_SPEED; }
  function fmtDuration(min) {
    const totalSec = Math.round(min * 60);
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    const p = n => String(n).padStart(2, "0");
    return (h > 0 ? h + "h" : "") + p(m) + "m" + p(s) + "s";
  }
  function arrivalClock(min) {
    const d = new Date(Date.now() + min * 60000);
    const p = n => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // ------------------------- LOG (silencioso) -------------------------
  const LOG = [];
  function log(msg, obj) {
    LOG.push(msg + (obj !== undefined ? " → " + (typeof obj === "object" ? JSON.stringify(obj) : String(obj)) : ""));
    if (LOG.length > 200) LOG.shift();
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

  // ------------------------- LEITURA DA VISÃO GERAL (mobile + desktop) -------------------------
  // Detecta mobile pela presença do #mobileHeader no documento buscado.
  function isMobileDoc(doc) { return !!doc.querySelector("#mobileHeader, #mobile_header"); }

  // Lê todas as aldeias de um grupo pela abordagem por CLASSES (funciona em
  // mobile e desktop — só muda o prefixo "m" nos seletores de recurso).
  // Baseado no Warehouse Balancer (Sophie "Shinko to Kuma").
  function readVillagesFromDoc(doc) {
    const $$ = sel => [...doc.querySelectorAll(sel)];
    const mob = isMobileDoc(doc);
    log("layout", mob ? "mobile" : "desktop");

    const villagesEls = $$(".quickedit-vn");
    let woodEls, clayEls, ironEls, whEls, farmEls, merchEls, pointsCells;

    if (mob) {
      woodEls = $$(".res.mwood, .warn_90.mwood, .warn.mwood");
      clayEls = $$(".res.mstone, .warn_90.mstone, .warn.mstone");
      ironEls = $$(".res.miron, .warn_90.miron, .warn.miron");
      whEls   = $$(".mheader.ressources");
      farmEls = $$(".header.population");
      merchEls = $$(".trader_img").map(t => t.parentElement);
      pointsCells = $$(".points-header");
    } else {
      woodEls = $$(".res.wood, .warn_90.wood, .warn.wood");
      clayEls = $$(".res.stone, .warn_90.stone, .warn.stone");
      ironEls = $$(".res.iron, .warn_90.iron, .warn.iron");
    }

    log("contagens", { aldeias: villagesEls.length, wood: woodEls.length, clay: clayEls.length, iron: ironEls.length });

    const villages = [];
    for (let i = 0; i < villagesEls.length; i++) {
      const el = villagesEls[i];
      const id = el.dataset ? el.dataset.id : null;
      const name = (el.innerText || el.textContent || "").trim();
      const mm = name.match(/(\d{1,3})\|(\d{1,3})/);
      if (!id || !mm) continue;

      const wood = num((woodEls[i] || {}).textContent);
      const stone = num((clayEls[i] || {}).textContent);
      const iron = num((ironEls[i] || {}).textContent);

      let storage = 0, merchants = 0, points = 0;
      if (mob) {
        if (whEls[i]) storage = num(whEls[i].parentElement ? whEls[i].parentElement.innerText : whEls[i].textContent);
        if (merchEls[i]) { const t = (merchEls[i].innerText || "").match(/(\d[\d.]*)/); merchants = t ? num(t[1]) : 0; }
        if (pointsCells[i]) { const kids = pointsCells[i].children; const last = kids.length ? kids[kids.length - 1] : pointsCells[i]; points = num(last.innerText || last.textContent); }
      } else {
        // desktop: as células seguem o elemento de ferro (mesma cadeia do original)
        const ironCell = ironEls[i] ? ironEls[i].parentElement : null;
        if (ironCell) {
          const whCell = ironCell.nextElementSibling;
          const merchCell = whCell ? whCell.nextElementSibling : null;
          if (whCell) storage = num(whCell.innerText || whCell.textContent);
          if (merchCell) { const t = (merchCell.innerText || "").match(/(\d+)\/(\d+)/); merchants = t ? num(t[1]) : 0; }
        }
        // pontos: célula anterior ao elemento de madeira
        const woodCell = woodEls[i] ? woodEls[i].parentElement : null;
        if (woodCell && woodCell.previousElementSibling) points = num(woodCell.previousElementSibling.innerText || woodCell.previousElementSibling.textContent);
      }

      villages.push({ id: +id, name: name.replace(/\s*\(\d+\|\d+\).*/, "").trim() || ("Aldeia " + id), x: +mm[1], y: +mm[2], wood, stone, iron, storage, merchants, points });
    }
    return villages;
  }

  async function readGroup(gid) {
    log("=== readGroup grupo " + gid + " ===");
    const u = "/game.php?screen=overview_villages&mode=prod&group=" + gid + "&page=-1";
    let txt = "";
    try {
      const r = await fetch(origin + u, { credentials: "same-origin" });
      txt = await r.text();
      log("fetch prod", r.status + " / " + txt.length + "b");
    } catch (e) { log("erro fetch", e.message); return { villages: [], missing: ["fetch"] }; }
    const doc = new DOMParser().parseFromString(txt, "text/html");
    const villages = readVillagesFromDoc(doc);
    log("total de aldeias lidas: " + villages.length);
    if (villages.length && villages[0]) log("1ª aldeia", { nome: villages[0].name, x: villages[0].x, y: villages[0].y, w: villages[0].wood, s: villages[0].stone, i: villages[0].iron, arm: villages[0].storage, merc: villages[0].merchants, pts: villages[0].points });
    const missing = [];
    if (villages.length && villages.every(v => !v.storage)) missing.push("armazém");
    if (villages.length && villages.every(v => !v.merchants)) missing.push("mercadores");
    return { villages, missing };
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
        const d = dist(src, dst);
        const send = { src, dst, merchants, dist: +d.toFixed(1), minutes: travelMinutes(d), wood: 0, stone: 0, iron: 0 };
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
      await loadWorldSpeed();
      log("velocidade do mundo", WORLD_SPEED);
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
  // ENVIO REAL (modo diagnóstico): dispara o envio e MOSTRA a resposta crua do
  // servidor. Só considera sucesso com sinal claro; senão mantém o cartão e
  // registra a resposta pra ajustarmos o endpoint.
  async function doSend(s, statusEl) {
    statusEl.textContent = "enviando…"; statusEl.style.color = "#e8d9a0";
    log("ENVIO " + s.src.name + "(" + s.src.id + ") -> " + s.dst.name + " w" + s.wood + " s" + s.stone + " i" + s.iron);
    // Método idêntico ao Warehouse Balancer (Shinko to Kuma), que funciona no br142:
    //   TribalWars.post("market", {ajaxaction:"map_send", village:origem}, {target_id, wood, stone, iron}, cb)
    return new Promise(resolve => {
      const data = { target_id: s.dst.id, wood: s.wood || 0, stone: s.stone || 0, iron: s.iron || 0 };
      let settled = false;
      const done = (ok, txt, color) => { if (settled) return; settled = true; statusEl.textContent = txt; statusEl.style.color = color; resolve(ok); };
      try {
        if (!(window.TribalWars && TribalWars.post)) { done(false, "✗ TribalWars.post indisponível", "#ffb4b4"); return; }
        TribalWars.post("market", { ajaxaction: "map_send", village: s.src.id }, data,
          function (resp) {
            log("  resposta OK", resp && (resp.message || JSON.stringify(resp)).slice(0, 200));
            try { if (resp && resp.message && window.UI && UI.SuccessMessage) UI.SuccessMessage(resp.message); } catch (e) {}
            done(true, "enviado ✓", "#9fe6b8");
          },
          false // 4º arg = false, igual ao script de referência (sem callback de erro próprio)
        );
        // TribalWars.post não tem timeout; se em 8s não confirmou, libera o cartão
        setTimeout(() => done(false, "sem resposta (tente de novo)", "#ffd9a0"), 8000);
      } catch (e) {
        log("  EXCEÇÃO", e.message);
        done(false, "✗ falha: " + e.message, "#ffb4b4");
      }
    });
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
      const tempo = s.minutes != null ? fmtDuration(s.minutes) + " · chega " + arrivalClock(s.minutes) : "";
      return '<div class="bg-card" data-card="' + i + '" style="border-top:1px solid #4a331d;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:170px">' +
          '<div>' + esc(s.src.name) + ' <span style="color:#c9a">(' + s.src.x + '|' + s.src.y + ')</span></div>' +
          '<div style="color:#8fd">↓ ' + s.dist + ' campos · ' + s.merchants + ' merc.' + (tempo ? ' · ⏱ ' + tempo : '') + '</div>' +
          '<div><b>' + esc(s.dst.name) + '</b> <span style="color:#c9a">(' + s.dst.x + '|' + s.dst.y + ')</span> <span style="color:#b98">' + fmt(s.dst.points) + ' pts</span></div>' +
          '<div style="color:#f0e6d8">' + parts.join("  ") + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:96px">' +
          '<button class="bg-send" data-i="' + i + '" style="background:#3a7d54;color:#eafff0;padding:11px 18px;border:none;border-radius:8px;font-weight:bold;font-size:15px;cursor:pointer">Enviar</button>' +
          '<span class="bg-status" data-si="' + i + '" style="font-size:12px;color:#b98;text-align:right;max-width:150px"></span>' +
        '</div>' +
        '</div>';
    }).join("");
    cards = '<div id="bg-cards">' + cards + '</div>';
    const emptyMsg = '<div id="bg-empty" style="padding:20px;text-align:center;color:#9fe6b8;display:' + (sends.length ? "none" : "block") + '">' + (sends.length ? "Todos os envios concluídos ✓" : "Nenhum envio necessário — destinos já cheios ou origens sem excedente.") + '</div>';

    const sendAllBtn = sends.length
      ? '<button id="bg-sendall" style="' + BTN + ';margin-top:6px">Enviar todos (' + sends.length + ')</button>'
      : "";

    w.innerHTML = headerBar("Plano de envios", renderSetup) + warn +
      '<div style="padding:12px 14px;color:#d8c3a6;font-size:13px">Origem <b>' + srcInfo.villages.length + '</b> · Destino <b>' + dstInfo.villages.length + '</b> · <b>' + sends.length + '</b> envio(s) · <b>' + totMerch + '</b> mercadores<br>Total: 🪵 ' + fmt(tot.wood) + "  🧱 " + fmt(tot.stone) + "  ⚙️ " + fmt(tot.iron) + '</div>' +
      '<div style="padding:0 14px">' + sendAllBtn + '</div>' +
      cards + emptyMsg +
      '<div style="padding:12px 14px;color:#b98;font-size:11px">Cada "Enviar" dispara na hora e some da lista quando confirmado. Destinos até ' + CFG.maxFillPercent + '% do armazém; origens mantêm ' + CFG.keepPercent + '%. ⏱ = tempo dos mercadores.</div>';

    // liga os botões
    const status = i => w.querySelector('.bg-status[data-si="' + i + '"]');
    const all = w.querySelector("#bg-sendall");
    let restantes = sends.length;
    function refreshCount() {
      restantes = w.querySelectorAll(".bg-card").length;
      if (all) all.textContent = restantes ? "Enviar todos (" + restantes + ")" : "concluído ✓";
      if (!restantes) {
        const emp = w.querySelector("#bg-empty");
        if (emp) { emp.textContent = "Todos os envios concluídos ✓"; emp.style.display = "block"; }
        if (all) all.style.display = "none";
      }
    }
    function removeCard(i) {
      const card = w.querySelector('.bg-card[data-card="' + i + '"]');
      if (card) {
        card.style.transition = "opacity .25s"; card.style.opacity = "0";
        setTimeout(() => { card.remove(); refreshCount(); }, 250);
      }
    }
    w.querySelectorAll(".bg-send").forEach(b => {
      b.onclick = async () => {
        const i = +b.dataset.i;
        if (b.dataset.done) return true;
        b.disabled = true; b.style.opacity = ".5";
        const ok = await doSend(sends[i], status(i));
        if (ok) { b.dataset.done = "1"; removeCard(i); }        // some da lista ao concluir
        else { b.disabled = false; b.style.opacity = "1"; b.textContent = "tentar de novo"; }
        return ok;
      };
    });
    if (all) all.onclick = async () => {
      all.disabled = true;
      const btns = [...w.querySelectorAll(".bg-send")];
      let done = 0;
      for (const b of btns) {
        if (b.dataset.done) continue;
        done++;
        await b.onclick();
        await sleep(450); // evita disparar rápido demais
      }
      all.disabled = false;
      refreshCount();
    };
  }

  // ------------------------- EXECUÇÃO -------------------------
  renderSetup();
})();
