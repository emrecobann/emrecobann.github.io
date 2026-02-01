/* Radiology Impression Rater v5
 * - Professional UI with improved accessibility
 * - Everyone sees DIFFERENT cases (userId-seeded)
 * - Sample size: 10, 15, or 20
 * - Per-model scoring (1–5)
 * - Supabase sync + localStorage backup
 *
 * Important deployment note:
 * - Must be served over http(s) (GitHub Pages)
 * - Opening index.html via file:// will cause fetch() to fail
 */

// ===== SUPABASE CONFIG =====
const SUPABASE_URL = "https://oqfbijskgpfqhbonbjww.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xZmJpanNrZ3BmcWhib25iand3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5MzIxMTksImV4cCI6MjA4NTUwODExOX0.9lbI8zWpPRytiO5j__DeniQ73d0ouuvsj17RDFsS_4s";

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

const STORAGE_PREFIX = "rad_rater_v4";
const AUTO_SAVE_INTERVAL = 30000; // 30 seconds

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

// ===== SUPABASE FUNCTIONS =====
async function supabaseGet(userId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(userId)}&select=*`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      }
    });
    if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
    const rows = await res.json();
    if (rows.length > 0) {
      return rows[0].data;
    }
    return null;
  } catch (e) {
    console.warn('Supabase GET error:', e);
    return null;
  }
}

async function supabaseSave(userId, state) {
  try {
    // First check if user exists
    const existing = await fetch(`${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(userId)}&select=id`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      }
    });
    const rows = await existing.json();

    const payload = {
      user_id: userId,
      data: state,
      updated_at: new Date().toISOString()
    };

    let res;
    if (rows.length > 0) {
      // Update existing
      res = await fetch(`${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(payload)
      });
    } else {
      // Insert new
      res = await fetch(`${SUPABASE_URL}/rest/v1/ratings`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) throw new Error(`Supabase save failed: ${res.status}`);
    return true;
  } catch (e) {
    console.error('Supabase save error:', e);
    return false;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function fetchCsv(file) {
  // Try fetch first, fallback to XMLHttpRequest for file:// protocol
  let text;

  if (location.protocol === "file:") {
    // XMLHttpRequest works with file:// in some browsers
    text = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", file, true);
      xhr.onload = () => {
        if (xhr.status === 0 || xhr.status === 200) {
          resolve(xhr.responseText);
        } else {
          reject(new Error(`XHR failed (${xhr.status}): ${file}`));
        }
      };
      xhr.onerror = () => reject(new Error(`XHR error loading: ${file}. Chrome blocks file:// requests. Try Firefox or use python -m http.server.`));
      xhr.send();
    });
  } else {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(`CSV fetch failed (${res.status}): ${file}`);
    text = await res.text();
  }

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
let autoSaveTimer = null;

// Show toast notification
function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      ${type === 'success' ? '<polyline points="20 6 9 17 4 12"/>' :
      type === 'error' ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' :
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'}
    </svg>
    <span>${message}</span>
  `;
  document.body.appendChild(toast);

  // Add toast styles if not exists
  if (!document.querySelector('#toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      .toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(100px);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 20px;
        border-radius: 12px;
        background: rgba(20, 25, 40, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,0.1);
        color: #eaf0ff;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 12px 40px rgba(0,0,0,0.4);
        z-index: 9999;
        animation: toastIn 0.3s ease forwards;
      }
      .toast-success { border-color: rgba(43, 228, 167, 0.4); }
      .toast-success svg { color: #2be4a7; }
      .toast-error { border-color: rgba(255, 77, 109, 0.4); }
      .toast-error svg { color: #ff4d6d; }
      .toast-warning { border-color: rgba(232, 169, 78, 0.4); }
      .toast-warning svg { color: #e8a94e; }
      .toast-info svg { color: #5a7bb5; }
      @keyframes toastIn {
        to { transform: translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function init() {
  $("btnStart").addEventListener("click", onStart);
  $("btnPrev").addEventListener("click", onPrev);
  $("btnSaveNext").addEventListener("click", onSaveNext);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!STATE) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft' || e.key === 'p') onPrev();
    if (e.key === 'ArrowRight' || e.key === 'n') onSaveNext();
  });

  // Warn before leaving with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (STATE) {
      saveState(STATE.user.id, STATE);
    }
  });
}
document.addEventListener("DOMContentLoaded", init);

async function onStart() {
  const userId = $("userId").value.trim();
  const sampleSize = 10; // Fixed: 10 cases per dataset

  if (!userId) {
    $("loginStatus").textContent = "⚠️ User ID is required.";
    $("userId").focus();
    return;
  }

  $("loginStatus").innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div class="spinner"></div>
      <span>Loading...</span>
    </div>
  `;

  // Add spinner styles
  if (!document.querySelector('#spinner-styles')) {
    const style = document.createElement('style');
    style.id = 'spinner-styles';
    style.textContent = `
      .spinner {
        width: 18px; height: 18px;
        border: 2px solid rgba(90,123,181,0.2);
        border-top-color: #5a7bb5;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // Try to load from Supabase first, fallback to localStorage
  let state = await supabaseGet(userId);
  if (!state) {
    state = loadState(userId);
  }

  if (!state) {
    state = {
      version: 5,
      user: { id: userId, created_at: nowISO() },
      config: { sample_size_per_dataset: sampleSize },
      datasets: {},
      audit: { last_saved_at: null, save_count: 0 },
    };
  } else {
    // do NOT overwrite sample size if datasets already built (keeps consistency)
    if (!Object.keys(state.datasets || {}).length) {
      state.config.sample_size_per_dataset = sampleSize || state.config.sample_size_per_dataset;
    }
  }

  try {
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
    setHidden($("userBadge"), false);

    // Update user badge with new structure
    const badgeText = $("userBadgeText");
    if (badgeText) {
      badgeText.textContent = STATE.user.id;
    } else {
      $("userBadge").textContent = `user: ${STATE.user.id}`;
    }

    renderTabs();
    renderCase();
    $("loginStatus").textContent = "";

    // Start auto-save timer
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    autoSaveTimer = setInterval(() => {
      if (STATE) {
        saveState(STATE.user.id, STATE);
        console.log('Auto-saved at', nowISO());
      }
    }, AUTO_SAVE_INTERVAL);

    showToast(`Welcome, ${STATE.user.id}!`, 'success');
  } catch (e) {
    console.error(e);
    const isFileProtocol = location.protocol === "file:";
    $("loginStatus").innerHTML =
      `<div style="color:#ff4d6d;">❌ Dataset loading error</div>
      <div style="margin-top:8px;color:var(--muted);">Error: ${escapeHtml(e.message)}</div>
      <div style="margin-top:12px;padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;font-size:12px;">
        <strong>Checklist:</strong><br>
        ${isFileProtocol ? `
        • <strong>file:// protocol</strong>: Chrome blocks CORS<br>
        • Try <strong>Firefox</strong> with file://<br>
        • Or run: <code>python -m http.server 8000</code> then open <code>localhost:8000</code><br>
        ` : `
        • Did you open <code>https://emrecobann.github.io</code>?<br>
        • Is index.html in repo root?<br>
        • Is data/ folder in repo root?<br>
        • First load may take 1-2 min for GitHub Pages deployment<br>
        `}
      </div>`;
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

  $("progressText").textContent = `${doneAll}/${totalAll} (bu dataset: ${done}/${total})`;
  const pct = totalAll ? Math.round((doneAll / totalAll) * 100) : 0;
  $("progressFill").style.width = `${pct}%`;

  // Update ARIA attributes for accessibility
  const progressEl = document.querySelector('.progress');
  if (progressEl) {
    progressEl.setAttribute('aria-valuenow', pct);
  }
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

  $("caseCard").innerHTML = `
    <div class="case-grid">
      <div class="panel">
        <h2>Case Information</h2>
        <div class="kv"><div class="k">Dataset</div><div class="v">${escapeHtml(ACTIVE_DATASET)}</div></div>
        <div class="kv"><div class="k">Indication</div><div class="v">${escapeHtml(c.indication || "-")}</div></div>
        <div class="kv"><div class="k">Findings</div><div class="v">${escapeHtml(c.findings || "-")}</div></div>

        <div class="kv">
          <div class="k">Comment (optional)</div>
          <textarea id="comment" class="input" rows="3" placeholder="Short note or explanation..." style="resize:vertical;">${escapeHtml(existing?.comment || "")}</textarea>
        </div>
      </div>

      <div class="panel">
        <h2>Model Outputs (Blinded)</h2>
        <div class="outputs" id="outputs"></div>
      </div>
    </div>
  `;

  const outEl = $("outputs");
  outEl.innerHTML = "";
  for (const modelKey of order) {
    const label = labelMap[modelKey];
    const outputText = (c.models[modelKey] || "").trim();
    const existingScore = existing?.model_scores?.[modelKey] || "";

    const headId = `head_${modelKey}`;
    const bodyId = `body_${modelKey}`;
    const scoreId = `score_${modelKey}`;

    const card = document.createElement("div");
    card.className = "output";
    card.innerHTML = `
      <div class="output-head" id="${headId}">
        <div class="output-title" style="font-weight:600;font-size:1.05em;">Model ${label}</div>
        <select class="model-score" id="${scoreId}" data-model="${modelKey}" aria-label="Model ${label} Score" style="min-width:90px;font-weight:500;" disabled>
          <option value="" ${!existingScore ? "selected" : ""}>Rate...</option>
          <option value="5" ${existingScore === "5" ? "selected" : ""}>⭐ 5</option>
          <option value="4" ${existingScore === "4" ? "selected" : ""}>⭐ 4</option>
          <option value="3" ${existingScore === "3" ? "selected" : ""}>⭐ 3</option>
          <option value="2" ${existingScore === "2" ? "selected" : ""}>⭐ 2</option>
          <option value="1" ${existingScore === "1" ? "selected" : ""}>⭐ 1</option>
        </select>
      </div>
      <div class="output-body" id="${bodyId}">
        <div class="output-text" style="line-height:1.6;">${escapeHtml(outputText || "[EMPTY]")}</div>
      </div>
    `;
    outEl.appendChild(card);

    const head = $(headId);
    const body = $(bodyId);
    const scoreSelect = $(scoreId);

    // Toggle model output on click
    head.addEventListener("click", () => {
      const isOpen = body.classList.toggle("open");
      scoreSelect.disabled = !isOpen;
    });
  }

  $("appStatus").textContent = existing
    ? `✅ Previously saved (${existing.saved_at.slice(0, 16).replace('T', ' ')}). You can edit and save again.`
    : `Not yet saved. Select scores and click "Save & Next".`;
}

function collectAnswer() {
  const d = STATE.datasets[ACTIVE_DATASET];
  const c = d.cases[ACTIVE_INDEX];
  const caseId = c.id;

  // Collect per-model scores
  const modelScores = {};
  document.querySelectorAll('.model-score').forEach(sel => {
    const modelKey = sel.dataset.model;
    const val = sel.value;
    if (modelKey && val) {
      modelScores[modelKey] = val;
    }
  });

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
    model_scores: modelScores,
    comment,
    open_model,
  };
}

function validateAnswer(ans) {
  const scoredCount = Object.keys(ans.model_scores || {}).length;
  const totalModels = MODEL_COLUMNS.length;
  if (scoredCount < totalModels) {
    const missing = totalModels - scoredCount;
    return `${missing} model(s) not scored. Please score all models.`;
  }
  return null;
}

async function onSaveNext() {
  const ans = collectAnswer();
  const err = validateAnswer(ans);
  if (err) {
    $("appStatus").textContent = `⚠️ ${err}`;
    showToast(err, 'error');
    return;
  }

  const d = STATE.datasets[ACTIVE_DATASET];
  d.answers[ans.case_id] = ans;
  STATE.audit.last_saved_at = nowISO();
  STATE.audit.save_count = (STATE.audit.save_count || 0) + 1;

  // Save to localStorage first (backup)
  try {
    saveState(STATE.user.id, STATE);
  } catch (e) {
    console.error('LocalStorage save failed:', e);
  }

  // Save to Supabase (primary)
  const synced = await supabaseSave(STATE.user.id, STATE);
  if (synced) {
    showToast('Saved to cloud!', 'success');
  } else {
    showToast('Saved locally (cloud sync failed)', 'warning');
  }

  // Update status
  const { totalAll, doneAll } = computeOverallProgress();
  $("appStatus").textContent = `✅ Saved (${doneAll}/${totalAll} completed)`;

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
      showToast(`Switched to ${next.label} dataset`, 'info');
    } else {
      $("appStatus").textContent = "🎉 All datasets completed! Use Export to download results.";
      showToast('Congratulations! All cases completed!', 'success');
    }
  }
}

function onPrev() {
  const d = STATE.datasets[ACTIVE_DATASET];
  if (ACTIVE_INDEX > 0) {
    ACTIVE_INDEX -= 1;
    renderCase();
  } else {
    $("appStatus").textContent = "Already at the first case in this dataset.";
  }
}

function onExport() {
  if (!STATE) return;

  const { totalAll, doneAll } = computeOverallProgress();

  const exportObj = {
    exported_at: nowISO(),
    version: STATE.version,
    user: STATE.user,
    config: STATE.config,
    audit: {
      ...STATE.audit,
      export_count: (STATE.audit.export_count || 0) + 1,
      total_cases: totalAll,
      completed_cases: doneAll,
      completion_percentage: totalAll ? Math.round((doneAll / totalAll) * 100) : 0
    },
    model_map: Object.fromEntries(MODEL_COLUMNS.map(m => [m.key, { column: m.col, display: m.display }])),
    datasets: {},
  };

  for (const ds of DATASETS) {
    const d = STATE.datasets[ds.key];
    exportObj.datasets[ds.key] = {
      cases: d.cases.map(c => ({ id: c.id })),
      answers: d.answers,
      stats: {
        total: d.cases.length,
        completed: Object.keys(d.answers || {}).length
      }
    };
  }

  // Update audit in state
  STATE.audit.export_count = exportObj.audit.export_count;
  saveState(STATE.user.id, STATE);

  downloadText(`rater_results_${STATE.user.id}_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportObj, null, 2));
  showToast('Sonuclar indirildi!', 'success');
}

async function onReset() {
  if (!STATE) { $("loginStatus").textContent = "No active user."; return; }
  const ok = confirm(`⚠️ WARNING: This will permanently delete ALL ratings and progress for "${STATE.user.id}" from both local storage and cloud.\n\nThis action cannot be undone!\n\nAre you sure you want to continue?`);
  if (!ok) return;

  const userId = STATE.user.id;

  // Clear auto-save timer
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }

  // Delete from Supabase
  try {
    const url = `${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(userId)}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      }
    });
    if (!resp.ok) {
      console.warn("Supabase delete failed:", resp.status);
    }
  } catch (err) {
    console.warn("Supabase delete error:", err);
  }

  // Delete from localStorage
  localStorage.removeItem(storageKey(userId));

  showToast('All progress deleted from cloud and local storage', 'info');
  setTimeout(() => location.reload(), 500);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
