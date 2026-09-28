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
    w.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:2147483647;width:min(680px,100vw);max-height:92vh;overflow:auto;background:#241811;color:#f0e6d8;border:2px solid #7a5230;border-bottom:none;border-radius:12px 12px 0 0;font:15px/1.5 Verdana,Arial,sans-serif;box-shadow:0 -8px 40px rgba(0,0,0,.6);-webkit-text-size-adjust:100%";
    document.body.appendChild(w); return w;
  }
  const val = id => { const el = document.getElementById(id); return el ? num(el.value) : 0; };

  function render() {
    const rows = findVillageRows();
    const w = panel();

    if (!rows.length) {
      w.innerHTML = header() + '<div style="padding:16px;color:#ffb4b4">Não achei os campos de tropa nesta tela. Abra a <b>Praça de reunião → Chamar apoio</b> (screen=place&mode=call) e rode de novo.</div>';
      return;
    }

    // soma disponível total por unidade (para mostrar de referência)
    const totalAvail = {}; UNITS.forEach(u => totalAvail[u] = 0);
    rows.forEach(r => UNITS.forEach(u => totalAvail[u] += unitAvailable(r, u)));

    const targetInputs = UNITS.map(u =>
      '<div style="flex:1;min-width:88px"><label style="' + LBL + '">' + NAMES[u] + '<br><span style="color:#8a7">disp. ' + fmt(totalAvail[u]) + '</span></label>' +
      '<input id="apm-t-' + u + '" inputmode="numeric" placeholder="0" style="' + INP + '"></div>'
    ).join("");

    const maxInputs = UNITS.map(u =>
      '<div style="flex:1;min-width:88px"><label style="' + LBL + '">' + NAMES[u] + '</label>' +
      '<input id="apm-m-' + u + '" inputmode="numeric" placeholder="0 = sem limite" style="' + INP + '"></div>'
    ).join("");

    w.innerHTML = header() +
      '<div style="padding:14px 16px;color:#d8c3a6;font-size:13px;border-bottom:1px solid #4a331d"><b>' + rows.length + '</b> aldeia(s) disponível(is) nesta tela.</div>' +
      '<div style="padding:14px 16px">' +
        '<div style="color:#9fe6b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">1 · Quantas tropas quero na aldeia (alvo total)</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + targetInputs + '</div>' +
        '<div style="color:#e8c98a;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px">2 · Máximo a usar de CADA aldeia (0 = sem limite)</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + maxInputs + '</div>' +
        '<div id="apm-msg" style="color:#ffd9a0;font-size:13px;margin-top:12px"></div>' +
        '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">' +
          '<button id="apm-fill" style="' + BTN + ';flex:2;min-width:180px">Preencher campos</button>' +
          '<button id="apm-clear" style="' + BTN + ';flex:1;min-width:120px;background:#5a3a2a">Limpar</button>' +
        '</div>' +
        '<div style="color:#b98;font-size:11px;margin-top:10px">O script só preenche os campos, distribuindo de forma equilibrada entre as aldeias (proporcional ao que cada uma tem, respeitando o máximo). Você confere e clica em enviar no jogo.</div>' +
      '</div>' +
      '<div id="apm-result"></div>';

    document.getElementById("apm-fill").onclick = () => {
      const targets = {}; UNITS.forEach(u => targets[u] = val("apm-t-" + u));
      const maxPer = {}; UNITS.forEach(u => maxPer[u] = val("apm-m-" + u));
      const totalTarget = UNITS.reduce((s, u) => s + targets[u], 0);
      const msg = document.getElementById("apm-msg");
      if (totalTarget <= 0) { msg.textContent = "Defina ao menos um alvo de tropa."; return; }

      const { assign } = distribute(rows, targets, maxPer);
      const usedUnits = UNITS.filter(u => targets[u] > 0);
      const filled = fillFields(rows, assign, usedUnits);

      // resumo do que foi alocado vs alvo
      const got = {}; UNITS.forEach(u => got[u] = 0);
      assign.forEach(a => UNITS.forEach(u => got[u] += a[u]));
      let resHtml = '<div style="padding:8px 16px 16px"><div style="color:#9fe6b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:8px 0">Resultado (alocado / alvo)</div><table style="width:100%;border-collapse:collapse;font-size:13px">';
      UNITS.forEach(u => {
        if (!targets[u]) return;
        const falta = targets[u] - got[u];
        resHtml += '<tr style="border-top:1px solid #4a331d"><td style="padding:5px 4px">' + NAMES[u] + '</td>' +
          '<td style="padding:5px 4px;text-align:right;font-family:monospace">' + fmt(got[u]) + ' / ' + fmt(targets[u]) + '</td>' +
          '<td style="padding:5px 4px;text-align:right;color:' + (falta > 0 ? "#e5877d" : "#9fe6b8") + '">' + (falta > 0 ? "faltam " + fmt(falta) : "ok ✓") + '</td></tr>';
      });
      resHtml += '</table></div>';
      document.getElementById("apm-result").innerHTML = resHtml;
      msg.innerHTML = '<span style="color:#9fe6b8">✓ ' + filled + ' campo(s) preenchido(s) em ' + rows.length + ' aldeia(s). Confira e clique em enviar no jogo.</span>';
    };
    document.getElementById("apm-clear").onclick = () => { clearFields(rows); document.getElementById("apm-result").innerHTML = ""; document.getElementById("apm-msg").innerHTML = '<span style="color:#b98">Campos limpos.</span>'; };
  }

  function header() {
    return '<div style="position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#3a2716;padding:12px 14px;border-bottom:1px solid #7a5230"><b>Apoio em massa (preencher)</b><span style="cursor:pointer;font-size:20px;padding:0 6px" onclick="document.getElementById(\'apm-panel\').remove()">✕</span></div>';
  }

  render();
})();
