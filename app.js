/* Radiology Impression Rater v3
 * - Everyone sees DIFFERENT cases (userId-seeded). No sampling-mode selector in UI.
 * - Sample size selectable 10..20.
 * - Single overall score (1–5) per case.
 * - Offline-first: localStorage + optional remote POST endpoint
 *
 * Important deployment note:
 * - Must be served over http(s) (GitHub Pages).
 * - Opening index.html via file:// will cause fetch() to fail.
 */

const DATASETS = [
  { key: "rexgradient", label: "RexGradient", file: "data/rexgradient_all_predictions_final.csv" },
  { key: "chexpert", label: "CheXpert", file: "data/chexpert_all_predictions_final.csv" },
  { key: "mimic", label: "MIMIC-CXR", file: "data/mimic_all_predictions_final.csv" },
];

const MODEL_COLUMNS = [
  { key: "m1", col: "m1_7B_23K_impression", display: "M1 (Medical)" },
  { key: "qwen8b_zs", col: "qwen3_8b_base_impression", display: "Qwen3-8B (Zero-shot)" },
  { key: "qwen14b_zs", col: "qwen3_14b_base_impression", display: "Qwen3-14B (Zero-shot)" },
  { key: "qwen8b_sft", col: "qwen3_8b_lora_impression", display: "Qwen3-8B (SFT)" },
  { key: "qwen8b_rl", col: "qwen3_8b_lora_rl_impression", display: "Qwen3-8B (SFT+RL)" },
  { key: "qwen14b_sft", col: "qwen3_14b_lora_impression", display: "Qwen3-14B (SFT)" },
  { key: "qwen14b_rl", col: "qwen3_14b_lora_rl_impression", display: "Qwen3-14B (SFT+RL)" },
];

const STORAGE_PREFIX = "rad_rater_v3";

function $(id) { return document.getElementById(id); }

function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededSample(array, n, seedStr) {
  const seed = stableHash(seedStr);
  const rnd = mulberry32(seed);
  const idx = array.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, idx.length)).map(i => array[i]);
}

function setHidden(el, hidden) { el.classList.toggle("hidden", hidden); }
function nowISO() { return new Date().toISOString(); }
function storageKey(userId) { return `${STORAGE_PREFIX}:${userId}`; }

function loadState(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { console.warn("loadState failed", e); return null; }
}
function saveState(userId, state) { localStorage.setItem(storageKey(userId), JSON.stringify(state)); }

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function fetchCsv(file) {
  const res = await fetch(file, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed (${res.status}): ${file}`);
  const text = await res.text();
  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

function normalizeRow(row) {
  const safe = {
    id: row.id,
    findings: row.findings ?? "",
    indication: row.indication ?? "",
    ground_truth: row.ground_truth ?? "",
  };
  for (const m of MODEL_COLUMNS) {
    safe[m.key] = row[m.col] ?? "";
  }
  return safe;
}

function buildBlindedOrder(userId, datasetKey, caseId) {
  const seedStr = `${userId}::${datasetKey}::${caseId}::modelorder`;
  const seed = stableHash(seedStr);
  const rnd = mulberry32(seed);
  const keys = MODEL_COLUMNS.map(m => m.key);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}

// ---------- UI State ----------
let STATE = null;
let ACTIVE_DATASET = null;
let ACTIVE_INDEX = 0;

function init() {
  // populate sample size: only 10, 15, 20
  const sel = $("sampleSize");
  sel.innerHTML = "";
  const allowedSizes = [10, 15, 20];
  for (const n of allowedSizes) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === 15) opt.selected = true;
    sel.appendChild(opt);
  }

  $("btnStart").addEventListener("click", onStart);
  $("btnPrev").addEventListener("click", onPrev);
  $("btnSaveNext").addEventListener("click", onSaveNext);
  $("btnExport").addEventListener("click", onExport);
  $("btnReset").addEventListener("click", onReset);
  // Hide remote endpoint field if present (for safety)
  const remoteField = document.getElementById("remoteEndpoint");
  if (remoteField) remoteField.parentElement.style.display = "none";
}
document.addEventListener("DOMContentLoaded", init);

async function onStart() {
  const userId = $("userId").value.trim();
  const userMeta = $("userMeta").value.trim();
  const sampleSize = parseInt($("sampleSize").value, 10);

  if (!userId) {
    $("loginStatus").textContent = "⚠️ Kullanıcı ID gerekli.";
    return;
  }

  $("loginStatus").textContent = "Loading datasets…";

  let state = loadState(userId);
  if (!state) {
    state = {
      version: 3,
      user: { id: userId, meta: userMeta, created_at: nowISO() },
      config: { sample_size_per_dataset: sampleSize },
      datasets: {},
      audit: { last_saved_at: null },
    };
  } else {
    state.user.meta = userMeta || state.user.meta || "";
    // do NOT overwrite sample size if datasets already built (keeps consistency)
    if (!Object.keys(state.datasets || {}).length) {
      state.config.sample_size_per_dataset = sampleSize || state.config.sample_size_per_dataset;
    }
  }

  try {
    // Helpful error if running from file://
    if (location.protocol === "file:") {
      throw new Error("Bu sayfayı file:// ile açtın. fetch() çalışmaz. GitHub Pages veya local server (python -m http.server) ile açmalısın.");
    }

    for (const ds of DATASETS) {
      if (state.datasets[ds.key]?.cases?.length) continue;

      const rows = await fetchCsv(ds.file);
      const normalized = rows.map(normalizeRow);

      const seedBase = `${userId}::${ds.key}::sample`;
      const sampled = seededSample(normalized, state.config.sample_size_per_dataset, seedBase);

      state.datasets[ds.key] = {
        cases: sampled.map(r => ({
          id: String(r.id),
          findings: r.findings,
          indication: r.indication,
          ground_truth: r.ground_truth,
          models: Object.fromEntries(MODEL_COLUMNS.map(m => [m.key, r[m.key]])),
        })),
        cursor: 0,
        answers: {},
      };
    }

    saveState(userId, state);
    STATE = state;
    ACTIVE_DATASET = DATASETS[0].key;
    ACTIVE_INDEX = state.datasets[ACTIVE_DATASET].cursor || 0;

    setHidden($("screenLogin"), true);
    setHidden($("screenApp"), false);
    setHidden($("btnExport"), false);
    setHidden($("btnReset"), false);
    setHidden($("userBadge"), false);
    $("userBadge").textContent = `user: ${STATE.user.id}`;

    renderTabs();
    renderCase();
    $("loginStatus").textContent = "";
  } catch (e) {
    console.error(e);
    $("loginStatus").textContent =
      `❌ Dataset load failed.\n` +
      `Hata: ${e.message}\n\n` +
      `Kontrol listesi:\n` +
      `• index.html repo root’ta mı?\n` +
      `• data/ klasörü repo root’ta mı?\n` +
      `• Dosya isimleri birebir aynı mı? (case-sensitive)\n` +
      `• Siteyi https://emrecobann.github.io üzerinden mi açtın? (file:// değil)\n` +
      `• İlk açılışta 1-2 dk cache/Pages deploy beklemen gerekebilir.`;
  }
}

function renderTabs() {
  const el = $("datasetTabs");
  el.innerHTML = "";
  for (const ds of DATASETS) {
    const b = document.createElement("div");
    b.className = "tab" + (ds.key === ACTIVE_DATASET ? " active" : "");
    b.textContent = ds.label;
    b.addEventListener("click", () => {
      ACTIVE_DATASET = ds.key;
      ACTIVE_INDEX = STATE.datasets[ACTIVE_DATASET].cursor || 0;
      renderTabs();
      renderCase();
    });
    el.appendChild(b);
  }
}

function computeOverallProgress() {
  const totals = DATASETS.map(ds => {
    const d = STATE.datasets[ds.key];
    const total = d.cases.length;
    const done = Object.keys(d.answers || {}).length;
    return { total, done };
  });
  const totalAll = totals.reduce((a, x) => a + x.total, 0);
  const doneAll = totals.reduce((a, x) => a + x.done, 0);
  return { totalAll, doneAll };
}

function renderProgress() {
  const d = STATE.datasets[ACTIVE_DATASET];
  const total = d.cases.length;
  const done = Object.keys(d.answers || {}).length;
  const { totalAll, doneAll } = computeOverallProgress();

  $("progressText").textContent = `${doneAll}/${totalAll} (this dataset: ${done}/${total})`;
  const pct = totalAll ? Math.round((doneAll / totalAll) * 100) : 0;
  $("progressFill").style.width = `${pct}%`;
}

function renderCase() {
  renderProgress();
  const d = STATE.datasets[ACTIVE_DATASET];
  const cases = d.cases;
  if (!cases.length) {
    $("caseCard").innerHTML = `<div class="panel">No cases.</div>`;
    return;
  }
  if (ACTIVE_INDEX < 0) ACTIVE_INDEX = 0;
  if (ACTIVE_INDEX >= cases.length) ACTIVE_INDEX = cases.length - 1;

  d.cursor = ACTIVE_INDEX;
  saveState(STATE.user.id, STATE);

  const c = cases[ACTIVE_INDEX];
  const caseId = c.id;

  const order = buildBlindedOrder(STATE.user.id, ACTIVE_DATASET, caseId);
  const labelMap = {};
  order.forEach((k, idx) => labelMap[k] = String.fromCharCode("A".charCodeAt(0) + idx));

  const existing = d.answers[caseId] || null;

  const gtToggleId = "toggle_gt";
  $("caseCard").innerHTML = `
    <div class="case-grid">
      <div class="panel">
        <h2>Case</h2>
        <div class="kv"><div class="k">Dataset</div><div class="v">${escapeHtml(ACTIVE_DATASET)}</div></div>
        <div class="kv"><div class="k">Case ID</div><div class="v">${escapeHtml(caseId)}</div></div>
        <div class="kv"><div class="k">Indication</div><div class="v">${escapeHtml(c.indication || "")}</div></div>
        <div class="kv"><div class="k">Findings</div><div class="v">${escapeHtml(c.findings || "")}</div></div>

        <div class="kv">
          <div class="k">
            <label style="display:flex;align-items:center;gap:10px;">
              <input type="checkbox" id="${gtToggleId}" ${existing?.show_gt ? "checked" : ""}/>
              Show GT Impression
            </label>
          </div>
          <div class="v" id="gt_block" style="display:${existing?.show_gt ? "block" : "none"}">${escapeHtml(c.ground_truth || "")}</div>
        </div>

        <div class="kv">
          <div class="k">Optional comment</div>
          <textarea id="comment" class="input" rows="3" placeholder="Kısa not…" style="resize:vertical;">${escapeHtml(existing?.comment || "")}</textarea>
        </div>
      </div>

      <div class="panel">
        <h2>Model Outputs (Blinded)</h2>
        <div class="outputs" id="outputs"></div>

        <div class="scorebox">
          <div class="score-row">
            <label style="color:var(--muted);font-size:12px;min-width:110px;">Overall Score</label>
            <select class="small" id="overall_score">
              <option value="" ${existing?.overall_score ? "" : "selected"}>—</option>
              <option value="1" ${existing?.overall_score === "1" ? "selected" : ""}>1 (bad)</option>
              <option value="2" ${existing?.overall_score === "2" ? "selected" : ""}>2</option>
              <option value="3" ${existing?.overall_score === "3" ? "selected" : ""}>3</option>
              <option value="4" ${existing?.overall_score === "4" ? "selected" : ""}>4</option>
              <option value="5" ${existing?.overall_score === "5" ? "selected" : ""}>5 (excellent)</option>
            </select>
          </div>
          <div class="help">Klinik doğruluk + relevance temel kriter. Dil akıcılığı ikincil.</div>
        </div>
      </div>
    </div>
  `;

  const gtToggle = $(gtToggleId);
  const gtBlock = $("gt_block");
  gtToggle.addEventListener("change", () => { gtBlock.style.display = gtToggle.checked ? "block" : "none"; });

  const outEl = $("outputs");
  outEl.innerHTML = "";
  for (const modelKey of order) {
    const label = labelMap[modelKey];
    const outputText = (c.models[modelKey] || "").trim();

    const headId = `head_${modelKey}`;
    const bodyId = `body_${modelKey}`;

    const card = document.createElement("div");
    card.className = "output";
    card.innerHTML = `
      <div class="output-head" id="${headId}">
        <div class="output-title">Model ${label}</div>
        <div class="output-meta">${escapeHtml(modelKey)}</div>
      </div>
      <div class="output-body ${existing?.open_model === modelKey ? "open" : ""}" id="${bodyId}">
        <div class="output-text">${escapeHtml(outputText || "[EMPTY]")}</div>
      </div>
    `;
    outEl.appendChild(card);

    const head = $(headId);
    const body = $(bodyId);
    head.addEventListener("click", () => {
      const isOpen = body.classList.contains("open");
      document.querySelectorAll(".output-body").forEach(x => x.classList.remove("open"));
      if (!isOpen) body.classList.add("open");
    });
  }

  $("appStatus").textContent = existing
    ? `✅ Saved already. You can edit and Save again. (Saved at: ${existing.saved_at})`
    : `Not saved yet.`;

  if (!existing) {
    const firstBody = document.querySelector(".output-body");
    if (firstBody) firstBody.classList.add("open");
  }
}

function collectAnswer() {
  const d = STATE.datasets[ACTIVE_DATASET];
  const c = d.cases[ACTIVE_INDEX];
  const caseId = c.id;

  const overall = document.getElementById("overall_score")?.value || "";
  const showGt = document.getElementById("toggle_gt")?.checked || false;
  const comment = document.getElementById("comment")?.value || "";

  const openEl = document.querySelector(".output-body.open");
  let open_model = null;
  if (openEl) {
    const id = openEl.id || "";
    open_model = id.replace("body_", "");
  }

  return {
    dataset: ACTIVE_DATASET,
    case_id: caseId,
    saved_at: nowISO(),
    show_gt: showGt,
    overall_score: overall,
    comment,
    open_model,
  };
}

function validateAnswer(ans) {
  if (!ans.overall_score) return "Overall Score seç (1–5).";
  return null;
}

// Remote sync is disabled; always return skipped
async function tryRemoteSync(record) {
  return { ok: false, skipped: true };
}

async function onSaveNext() {
  const ans = collectAnswer();
  const err = validateAnswer(ans);
  if (err) { $("appStatus").textContent = `⚠️ ${err}`; return; }

  const d = STATE.datasets[ACTIVE_DATASET];
  d.answers[ans.case_id] = ans;
  STATE.audit.last_saved_at = nowISO();
  saveState(STATE.user.id, STATE);

  // Only local save
  $("appStatus").textContent = "✅ Saved locally. (GitHub Pages: Sonuçlar tarayıcıda saklanır)";

  if (ACTIVE_INDEX < d.cases.length - 1) {
    ACTIVE_INDEX += 1;
    renderCase();
  } else {
    const next = DATASETS.find(ds => {
      const x = STATE.datasets[ds.key];
      return Object.keys(x.answers).length < x.cases.length;
    });
    if (next) {
      ACTIVE_DATASET = next.key;
      ACTIVE_INDEX = STATE.datasets[ACTIVE_DATASET].cursor || 0;
      renderTabs(); renderCase();
    } else {
      $("appStatus").textContent = "🎉 Completed all datasets. Export ile sonuçları indir.";
    }
  }
}

function onPrev() {
  const d = STATE.datasets[ACTIVE_DATASET];
  if (ACTIVE_INDEX > 0) { ACTIVE_INDEX -= 1; renderCase(); }
  else { $("appStatus").textContent = "Already at first case in this dataset."; }
}

function onExport() {
  if (!STATE) return;
  const exportObj = {
    exported_at: nowISO(),
    version: STATE.version,
    user: STATE.user,
    config: STATE.config,
    audit: STATE.audit,
    model_map: Object.fromEntries(MODEL_COLUMNS.map(m => [m.key, { column: m.col, display: m.display }])),
    datasets: {},
  };
  for (const ds of DATASETS) {
    const d = STATE.datasets[ds.key];
    exportObj.datasets[ds.key] = { cases: d.cases.map(c => ({ id: c.id })), answers: d.answers };
  }
  downloadText(`rater_results_${STATE.user.id}.json`, JSON.stringify(exportObj, null, 2));
}

function onReset() {
  if (!STATE) { $("loginStatus").textContent = "No active user."; return; }
  const ok = confirm("This will delete local progress for this user ID. Continue?");
  if (!ok) return;
  localStorage.removeItem(storageKey(STATE.user.id));
  location.reload();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
