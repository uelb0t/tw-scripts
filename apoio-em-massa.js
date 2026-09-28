/* =========================================================================
   APOIO EM MASSA (preencher) — Tribal Wars (PC e mobile)
   -------------------------------------------------------------------------
   Roda na PRAÇA DE REUNIÃO em modo "chamar apoio":
     .../game.php?village=ALVO&screen=place&mode=call&target=ALVO
   Essa tela lista TODAS as aldeias disponíveis, cada uma com campos de tropa.

   Você define QUANTAS tropas quer que cheguem na aldeia (o alvo total, por tipo
   defensivo) e o MÁXIMO que pode sair de cada aldeia. O script distribui de
   forma balanceada entre as aldeias e PREENCHE os campos. Você confere e clica
   em enviar (o script não envia nada).

   Tropas consideradas: lanceiro, espada, arco, cavalaria pesada, explorador,
   paladino e catapulta.

   USO (quickbar), estando na tela de chamar apoio:
     javascript:$.getScript('https://SEU_HOST/apoio-em-massa.js')
   ========================================================================= */
(function () {
  "use strict";

  // unidades defensivas que o script controla (chave interna do jogo)
  const UNITS = ["spear", "sword", "archer", "heavy", "spy", "knight", "catapult"];
  const NAMES = { spear: "Lanceiro", sword: "Espada", archer: "Arco", heavy: "Cav. pesada", spy: "Explorador", knight: "Paladino", catapult: "Catapulta" };
  // limites iniciais sugeridos por unidade (máximo a tirar de cada aldeia)
  const DEFAULT_MAX = { spear: 600, sword: 300, archer: 600, heavy: 200, spy: 0, knight: 0, catapult: 0 };
  // ID da aldeia de destino (alvo) — vem da URL (target=) ou do game_data
  function targetVillageId() {
    const m = location.href.match(/[?&]target=(\d+)/);
    if (m) return m[1];
    try { return String(window.game_data.village.id); } catch (e) { return null; }
  }

  const doc = (window.frames.length > 0 && window.main) ? window.main.document : document;
  const $$ = (sel, root) => [...(root || doc).querySelectorAll(sel)];
  const num = s => { const n = parseInt(String(s == null ? "" : s).replace(/[^\d]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const fmt = n => (n || 0).toLocaleString("pt-BR");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------- localizar as linhas de aldeia + inputs -------------------------
  // Tela real de chamar apoio (mode=call): cada aldeia é <tr class="call-village">,
  // cada tropa é <td data-unit="spear" data-count="263"> com input
  // name="call[VID][spear]" class="call-unit-box-spear" e o max no atributo max.
  function findVillageRows() {
    let rows = $$("tr.call-village");
    if (!rows.length) rows = $$('tr[id^="call_village_"]');
    return rows;
  }

  // input daquela unidade na linha
  function unitInput(row, unit) {
    return row.querySelector('input.call-unit-box-' + unit) ||
           row.querySelector('input[name$="[' + unit + ']"]') ||
           row.querySelector('[data-unit="' + unit + '"] input');
  }
  // disponível = data-count do <td data-unit="..."> (fonte limpa), com fallback no max
  function unitAvailable(row, unit) {
    const td = row.querySelector('td[data-unit="' + unit + '"]');
    if (td && td.getAttribute("data-count") != null) return num(td.getAttribute("data-count"));
    const inp = unitInput(row, unit);
    if (inp && inp.getAttribute("max") != null) return num(inp.getAttribute("max"));
    return 0;
  }
  // coordenada/nome da aldeia daquela linha
  function rowLabel(row) {
    const link = row.querySelector("a");
    const t = (row.textContent || "");
    const mm = t.match(/(\d{1,3})\|(\d{1,3})/);
    let name = link ? (link.textContent || "").trim() : "";
    name = name.replace(/\s*\(\d+\|\d+\).*/, "").trim();
    return (name || "Aldeia") + (mm ? " (" + mm[1] + "|" + mm[2] + ")" : "");
  }

  // ------------------------- distribuição balanceada -------------------------
  // Para cada unidade, distribui o alvo entre as aldeias proporcionalmente ao
  // que cada uma tem disponível, respeitando o máximo por aldeia.
  function distribute(rows, targets, maxPerVillage) {
    // estado por aldeia/unidade
    const avail = rows.map(r => {
      const a = {}; UNITS.forEach(u => a[u] = unitAvailable(r, u)); return a;
    });
    const assign = rows.map(() => { const a = {}; UNITS.forEach(u => a[u] = 0); return a; });

    UNITS.forEach(u => {
      let need = Math.max(0, targets[u] || 0);
      if (need <= 0) return;
      // capacidade de cada aldeia para esta unidade = min(disponível, máximo configurado)
      const cap = rows.map((r, i) => {
        let c = avail[i][u];
        if (maxPerVillage[u] > 0) c = Math.min(c, maxPerVillage[u]);
        return c;
      });
      let totalCap = cap.reduce((s, c) => s + c, 0);
      if (totalCap <= 0) return;
      // 1ª passada: proporcional ao disponível
      let assigned = 0;
      rows.forEach((r, i) => {
        if (need <= 0 || cap[i] <= 0) return;
        let give = Math.floor(need * (cap[i] / totalCap));
        give = Math.min(give, cap[i]);
        assign[i][u] = give; assigned += give;
      });
      // 2ª passada: distribui o resto (arredondamentos) para quem ainda tem capacidade
      let rest = need - assigned;
      for (let i = 0; i < rows.length && rest > 0; i++) {
        const room = cap[i] - assign[i][u];
        if (room <= 0) continue;
        const add = Math.min(room, rest);
        assign[i][u] += add; rest -= add;
      }
    });
    return { assign, avail };
  }

  // ------------------------- preencher os campos -------------------------
  // marca o checkbox de cabeçalho de uma unidade (a tela habilita a coluna por ele)
  function enableUnitColumn(unit) {
    // checkbox costuma estar no cabeçalho, perto do ícone da unidade; tenta por vários caminhos
    const cands = $$('th input[type="checkbox"], thead input[type="checkbox"], .call-unit-select-' + unit + ' input[type="checkbox"]');
    // heurística: acha o checkbox cuja célula/linha referencia a unidade
    let box = doc.querySelector('input[type="checkbox"][name*="' + unit + '"], input[type="checkbox"][data-unit="' + unit + '"]');
    if (!box) {
      // procura um th que contenha o ícone unit_ e pegue seu checkbox
      const th = $$("th").find(h => h.querySelector('.unit_link, .unit-' + unit + ', [class*="' + unit + '"]'));
      if (th) box = th.querySelector('input[type="checkbox"]');
    }
    if (box && !box.checked) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); box.dispatchEvent(new Event("click", { bubbles: true })); }
  }

  function fillFields(rows, assign, usedUnits) {
    // 1) tenta marcar as colunas das unidades usadas (a tela habilita os inputs por elas)
    usedUnits.forEach(u => enableUnitColumn(u));
    let filled = 0;
    rows.forEach((r, i) => {
      UNITS.forEach(u => {
        const inp = unitInput(r, u);
        if (!inp) return;
        const v = assign[i][u] || 0;
        inp.disabled = false;                 // garante habilitado mesmo se o checkbox não pegou
        inp.removeAttribute("disabled");
        inp.value = v > 0 ? v : "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("keyup", { bubbles: true }));
        if (v > 0) filled++;
      });
    });
    return filled;
  }
  function clearFields(rows) {
    rows.forEach(r => UNITS.forEach(u => { const inp = unitInput(r, u); if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); } }));
  }

  // ------------------------- UI -------------------------
  const INP = "width:100%;box-sizing:border-box;font-size:16px;padding:9px;background:#1e130a;color:#f0e6d8;border:1px solid #7a5230;border-radius:8px";
  const LBL = "display:block;font-size:11px;color:#c9a67e;margin:0 0 3px;text-transform:uppercase;letter-spacing:.04em";
  const BTN = "font-size:15px;font-weight:bold;padding:12px;background:#3a7d54;color:#eafff0;border:none;border-radius:8px;cursor:pointer";

  function panel() {
    document.getElementById("apm-panel")?.remove();
    const w = document.createElement("div"); w.id = "apm-panel";
    w.style.cssText = "position:fixed;left:0;top:0;bottom:0;z-index:2147483647;width:min(340px,88vw);max-height:100vh;overflow:auto;background:#241811;color:#f0e6d8;border-right:2px solid #7a5230;border-radius:0;font:14px/1.45 Verdana,Arial,sans-serif;box-shadow:6px 0 30px rgba(0,0,0,.55);-webkit-text-size-adjust:100%";
    document.body.appendChild(w); return w;
  }
  const val = id => { const el = document.getElementById(id); return el ? num(el.value) : 0; };

  // Lê as tropas que a aldeia de DESTINO já tem (próprias + apoios), somando
  // o que está lá + o que está a caminho, para descontar do alvo.
  // Fonte: tela de tropas do destino (screen=place&mode=units ou overview do destino).
  async function readTargetTroops(tid) {
    const have = {}; UNITS.forEach(u => have[u] = 0);
    if (!tid) return { have, ok: false };
    // a praça do destino (mode=units) mostra "na aldeia" + "a caminho" por unidade
    try {
      const r = await fetch(location.origin + "/game.php?village=" + tid + "&screen=place&mode=units", { credentials: "same-origin" });
      const doc2 = new DOMParser().parseFromString(await r.text(), "text/html");
      // procura uma tabela de tropas com colunas por unidade; soma "own" + "support"
      // padrão: células com data-unit ou classe unit_link_<u>, e linhas "na aldeia"/"total"
      let found = false;
      UNITS.forEach(u => {
        // tenta várias formas de achar o total daquela unidade no destino
        const cells = [...doc2.querySelectorAll('[data-unit="' + u + '"], .unit-item-' + u + ', td.unit-item.' + u)];
        // fallback: a tabela units_table tem colunas por unidade em ordem fixa
        if (cells.length) { cells.forEach(c => { const n = num(c.getAttribute("data-count") || c.textContent); if (n) have[u] = Math.max(have[u], n); }); found = true; }
      });
      // fallback robusto: tabela #units_table com linha "total" (own+support)
      if (!found) {
        const table = doc2.querySelector("#units_table, table.vis");
        if (table) {
          // mapeia colunas pelo header (ícones de unidade) e pega a linha "total"/"na aldeia"
          const heads = [...table.querySelectorAll("thead th, tr th")];
          const colOf = {};
          heads.forEach((th, i) => { const cls = (th.innerHTML || ""); UNITS.forEach(u => { if (new RegExp("unit_" + u + "\\b|/" + u + "\\.").test(cls) || (th.querySelector && th.querySelector('img[src*="' + u + '"]'))) colOf[u] = i; }); });
          const rowsT = [...table.querySelectorAll("tbody tr, tr")];
          // linha cujo primeiro td diz "no local"/"total"/"na aldeia" — somamos própria+apoio
          rowsT.forEach(tr => {
            const label = (tr.children[0] ? tr.children[0].textContent : "").toLowerCase();
            if (/local|aldeia|total|própri|apoio|support/.test(label)) {
              UNITS.forEach(u => { if (colOf[u] != null && tr.children[colOf[u]]) { const n = num(tr.children[colOf[u]].textContent); have[u] += n; } });
              found = true;
            }
          });
        }
      }
      return { have, ok: found };
    } catch (e) { return { have, ok: false }; }
  }

  async function render() {
    const rows = findVillageRows();
    const w = panel();

    if (!rows.length) {
      w.innerHTML = header() + '<div style="padding:16px;color:#ffb4b4">Não achei os campos de tropa nesta tela. Abra a tela <b>Enviar apoio em massa</b> e rode de novo.</div>';
      return;
    }

    // soma disponível total por unidade (para mostrar de referência)
    const totalAvail = {}; UNITS.forEach(u => totalAvail[u] = 0);
    rows.forEach(r => UNITS.forEach(u => totalAvail[u] += unitAvailable(r, u)));

    // lê o que a aldeia de destino JÁ TEM (próprias + a caminho)
    const tid = targetVillageId();
    const { have, ok: haveOk } = await readTargetTroops(tid);

    const targetInputs = UNITS.map(u =>
      '<div style="flex:1;min-width:96px"><label style="' + LBL + '">' + NAMES[u] +
      (haveOk ? '<br><span style="color:#8ad">tem ' + fmt(have[u]) + '</span>' : '') +
      '<br><span style="color:#8a7">disp. ' + fmt(totalAvail[u]) + '</span></label>' +
      '<input id="apm-t-' + u + '" inputmode="numeric" placeholder="0" style="' + INP + '"></div>'
    ).join("");

    const maxInputs = UNITS.map(u =>
      '<div style="flex:1;min-width:96px"><label style="' + LBL + '">' + NAMES[u] + '</label>' +
      '<input id="apm-m-' + u + '" inputmode="numeric" value="' + (DEFAULT_MAX[u] || "") + '" placeholder="0 = sem limite" style="' + INP + '"></div>'
    ).join("");

    const haveNote = haveOk
      ? '<div style="padding:0 16px 4px;color:#8ad;font-size:12px">✓ Li as tropas já presentes no destino — o alvo será descontado do que já existe.</div>'
      : '<div style="padding:0 16px 4px;color:#e8c98a;font-size:12px">⚠ Não consegui ler as tropas do destino; o alvo será tratado como total a enviar. (me avise pra ajustar)</div>';

    w.innerHTML = header() +
      '<div style="padding:12px 16px;color:#d8c3a6;font-size:13px;border-bottom:1px solid #4a331d"><b>' + rows.length + '</b> aldeia(s) de origem nesta tela.</div>' +
      haveNote +
      '<div style="padding:12px 16px">' +
        '<div style="color:#9fe6b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">1 · Alvo TOTAL de tropas na aldeia</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + targetInputs + '</div>' +
        '<div style="color:#e8c98a;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px">2 · Máximo por aldeia de origem</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + maxInputs + '</div>' +
        '<div id="apm-msg" style="color:#ffd9a0;font-size:13px;margin-top:12px"></div>' +
        '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">' +
          '<button id="apm-fill" style="' + BTN + ';flex:2;min-width:140px">Preencher</button>' +
          '<button id="apm-clear" style="' + BTN + ';flex:1;min-width:90px;background:#5a3a2a">Limpar</button>' +
        '</div>' +
        '<div style="color:#b98;font-size:11px;margin-top:10px">Preenche só a diferença (alvo − o que o destino já tem), distribuindo entre as origens proporcional ao que cada uma tem, respeitando o máximo. Você confere e clica em "Enviar apoio" no jogo.</div>' +
      '</div>' +
      '<div id="apm-result"></div>';

    document.getElementById("apm-fill").onclick = () => {
      const rawTargets = {}; UNITS.forEach(u => rawTargets[u] = val("apm-t-" + u));
      const maxPer = {}; UNITS.forEach(u => maxPer[u] = val("apm-m-" + u));
      const totalTarget = UNITS.reduce((s, u) => s + rawTargets[u], 0);
      const msg = document.getElementById("apm-msg");
      if (totalTarget <= 0) { msg.textContent = "Defina ao menos um alvo de tropa."; return; }

      // desconta o que o destino já tem → só envia a diferença
      const needTargets = {};
      UNITS.forEach(u => needTargets[u] = Math.max(0, rawTargets[u] - (haveOk ? have[u] : 0)));

      const { assign } = distribute(rows, needTargets, maxPer);
      const usedUnits = UNITS.filter(u => needTargets[u] > 0);
      const filled = fillFields(rows, assign, usedUnits);

      const got = {}; UNITS.forEach(u => got[u] = 0);
      assign.forEach(a => UNITS.forEach(u => got[u] += a[u]));
      let resHtml = '<div style="padding:8px 16px 16px"><div style="color:#9fe6b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:8px 0">Resultado</div><table style="width:100%;border-collapse:collapse;font-size:13px">';
      resHtml += '<tr style="color:#b98"><td style="padding:3px 4px">Tropa</td><td style="padding:3px 4px;text-align:right">enviar/faltava</td><td></td></tr>';
      UNITS.forEach(u => {
        if (!rawTargets[u]) return;
        const need = needTargets[u];
        const falta = need - got[u];
        resHtml += '<tr style="border-top:1px solid #4a331d"><td style="padding:5px 4px">' + NAMES[u] + (haveOk ? ' <span style="color:#8ad;font-size:11px">(tem ' + fmt(have[u]) + ')</span>' : '') + '</td>' +
          '<td style="padding:5px 4px;text-align:right;font-family:monospace">' + fmt(got[u]) + ' / ' + fmt(need) + '</td>' +
          '<td style="padding:5px 4px;text-align:right;color:' + (falta > 0 ? "#e5877d" : "#9fe6b8") + '">' + (need <= 0 ? "já ok" : (falta > 0 ? "faltam " + fmt(falta) : "✓")) + '</td></tr>';
      });
      resHtml += '</table></div>';
      document.getElementById("apm-result").innerHTML = resHtml;
      msg.innerHTML = '<span style="color:#9fe6b8">✓ ' + filled + ' campo(s) preenchido(s). Confira e clique em "Enviar apoio".</span>';
    };
    document.getElementById("apm-clear").onclick = () => { clearFields(rows); document.getElementById("apm-result").innerHTML = ""; document.getElementById("apm-msg").innerHTML = '<span style="color:#b98">Campos limpos.</span>'; };
  }

  function header() {
    return '<div style="position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#3a2716;padding:12px 14px;border-bottom:1px solid #7a5230"><b>Apoio em massa (preencher)</b><span style="cursor:pointer;font-size:20px;padding:0 6px" onclick="document.getElementById(\'apm-panel\').remove()">✕</span></div>';
  }

  render();
})();
