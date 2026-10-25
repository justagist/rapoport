// Rapoport: the arena page. Talks to the engine worker, keeps the visitor's
// strategies in localStorage and draws the matrix and the tapes.

const TEMPLATE = `import axelrod as axl
from axelrod.action import Action

C, D = Action.C, Action.D


class Probe(axl.Player):
    """Defect once to test the water, then forgive
    unless the opponent defects twice running."""

    name = "Probe"
    classifier = {
        "memory_depth": 2,
        "stochastic": False,
        "inspects_source": False,
        "manipulates_source": False,
        "manipulates_state": False,
    }

    def strategy(self, opponent):
        if len(self.history) == 0:
            return D
        if len(self.history) == 1:
            return C
        last_two = opponent.history[-2:]
        return D if last_two == [D, D] else C
`;

const $ = (id) => document.getElementById(id);
const ACCENT = "#1b6c80", INK = "#131416", MUTED = "#5d5f60";
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// ---------- service worker, then the engine ----------
// The service worker should control the page before the runtime download
// starts, so the first files are cached for the next visit. It must not hold
// the page up if it fails to install, so wait for it three seconds at most.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  await Promise.race([
    navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

const worker = new Worker("worker.js");
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  if (data.progress) { p.onProgress?.(data.progress, data.label); return; }
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};
function call(cmd, args, onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, cmd, args });
  });
}
const booting = call("init", {}, ([done, total], label) => { status(`${label} (${done + 1} of ${total})`); progress(done, total); });

// The editor is one vendored bundle (see tools/editor-entry.js) and loads in
// the background while the runtime downloads.
const editorLoading = import("./vendor/editor.js");

// ---------- state ----------
const store = {
  get strategies() { return JSON.parse(localStorage.getItem("rapoport.strategies") || "[]"); },
  set strategies(v) { localStorage.setItem("rapoport.strategies", JSON.stringify(v)); },
  get selected() { return JSON.parse(localStorage.getItem("rapoport.selected") || "null"); },
  set selected(v) { localStorage.setItem("rapoport.selected", JSON.stringify(v)); },
};
let strategies = store.strategies;
if (strategies.length === 0) {
  strategies = [{ id: "u" + Date.now().toString(36), name: "Probe", code: TEMPLATE }];
  store.strategies = strategies;
}
let selected = new Set(store.selected || ["TitForTat", "Defector", "Cooperator", "Grudger", "WinStayLoseShift", "FirstByJoss", "TitFor2Tats", strategies[0].id]);
let library = [];
let current = strategies[0].id;   // editor tab: a strategy id or "source"
let ready = false;
let running = false;
let result = null;                // last tournament
let tapeSel = null;               // {i, j, rep} into result, or {names, moves, scores, mine} for one match

const settings = () => {
  const read = (k) => parseFloat(document.querySelector(`.topbar [data-setting="${k}"]`).value);
  return { turns: Math.max(1, Math.round(read("turns"))), repetitions: Math.max(1, Math.round(read("repetitions"))), noise: Math.min(1, Math.max(0, read("noise") || 0)), seed: Math.round(read("seed")) || 0 };
};
// the roster's copy of the settings (shown on phones) mirrors the top bar's
for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("input", () => {
    for (const other of document.querySelectorAll(`[data-setting="${input.dataset.setting}"]`)) if (other !== input) other.value = input.value;
    drawEstimate();
  });
}
function field() {
  return [...strategies.filter((s) => selected.has(s.id)).map((s) => ({ kind: "user", id: s.id })),
          ...library.filter((s) => selected.has(s.id)).map((s) => ({ kind: "lib", id: s.id }))];
}

// ---------- status ----------
let statusError = null;   // a refusal or failure that the estimate must not overwrite
function status(text) { $("status").textContent = text; $("status-sheet").textContent = text; }
function progress(done, total) {
  const el = $("progress");
  el.hidden = done === null;
  if (done !== null) el.firstElementChild.style.width = `${Math.max(3, (100 * done) / total)}%`;
}
function drawEstimate() {
  if (!ready || running || statusError) return;
  const n = field().length, { repetitions } = settings();
  status(n < 2 ? "Pick at least two strategies." : `${((n * (n + 1)) / 2) * repetitions} matches to play.`);
}

// ---------- roster ----------
function drawClear() {
  $("clear").hidden = selected.size === 0;
  $("clear").textContent = `Clear ${selected.size} selected`;
}
function drawMine() {
  drawClear();
  $("mine").innerHTML = strategies.map((s) => `<li class="mine"><label><input type="checkbox" data-id="${s.id}" ${selected.has(s.id) ? "checked" : ""}><span>${esc(s.name)}</span></label></li>`).join("");
}
function drawLibrary() {
  const q = $("search").value.trim().toLowerCase();
  const rows = library.filter((s) => !q || s.name.toLowerCase().includes(q));
  $("lib").innerHTML = rows.map((s) => `<li><label><input type="checkbox" data-id="${s.id}" ${selected.has(s.id) ? "checked" : ""}><span>${esc(s.name)}</span></label>${s.slow ? '<span class="tag">slow</span>' : ""}</li>`).join("")
    || `<li class="pending">Nothing matches.</li>`;
}
$("search").addEventListener("input", drawLibrary);
document.querySelector(".roster").addEventListener("change", (e) => {
  const id = e.target.dataset?.id;
  if (!id) return;
  e.target.checked ? selected.add(id) : selected.delete(id);
  store.selected = [...selected];
  drawClear(); drawEstimate();
});
$("clear").addEventListener("click", () => {
  selected.clear(); store.selected = [];
  for (const c of document.querySelectorAll(".roster input:checked")) c.checked = false;
  drawClear(); drawEstimate();
});
$("new-strategy").addEventListener("click", () => {
  const s = { id: "u" + Date.now().toString(36), name: "Untitled", code: TEMPLATE.replace(/Probe/g, "MyStrategy") };
  strategies.push(s); store.strategies = strategies;
  selected.add(s.id); store.selected = [...selected];
  drawMine(); drawOpponents(); openTab(s.id); closeRoster(); drawEstimate();
});
const folded = matchMedia("(max-width: 1024px)");
function setRoster(open) {
  $("roster").classList.toggle("open", open);
  $("roster").inert = folded.matches && !open;
  $("menu").setAttribute("aria-expanded", String(open));
}
$("menu").addEventListener("click", () => { setRoster(!$("roster").classList.contains("open")); if ($("roster").classList.contains("open")) $("close-roster").focus(); });
function closeRoster() { const was = $("roster").classList.contains("open"); setRoster(false); if (was && folded.matches) $("menu").focus(); }
$("close-roster").addEventListener("click", closeRoster);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("roster").classList.contains("open")) closeRoster(); });
folded.addEventListener("change", () => setRoster($("roster").classList.contains("open")));
setRoster(false);

// ---------- editor ----------
let view = null, EditorState = null, EditorView = null, readOnly = null, wrapping = null;
const narrowEditor = matchMedia("(max-width: 640px)");
async function mountEditor() {
  try {
    const cm = await editorLoading;
    EditorView = cm.EditorView; EditorState = cm.EditorState; readOnly = new cm.Compartment(); wrapping = new cm.Compartment();
    const wrap = () => (narrowEditor.matches ? EditorView.lineWrapping : []);
    view = new EditorView({
      parent: $("cm"),
      state: EditorState.create({ doc: "", extensions: [cm.basicSetup, cm.python(), readOnly.of([]), wrapping.of(wrap()), EditorView.updateListener.of((u) => { if (u.docChanged && current !== "source") saveCode(); })] }),
    });
    narrowEditor.addEventListener("change", () => view.dispatch({ effects: wrapping.reconfigure(wrap()) }));
    return true;
  } catch {
    $("cm").innerHTML = `<p class="editor-fail">The code editor did not load. Reload to try again. Saved strategies still run.</p>`;
    return false;
  }
}
let saveTimer;
function saveCode() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = strategies.find((x) => x.id === current);
    if (s) { s.code = view.state.doc.toString(); store.strategies = strategies; }
  }, 300);
}
function setDoc(text, ro) {
  if (!view) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: readOnly.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
  $("cm").classList.toggle("readonly", ro);
}
function drawTabs() {
  $("tabs").innerHTML = strategies.map((s) => `<button role="tab" data-tab="${s.id}" aria-selected="${current === s.id}">${esc(s.name)}</button>`).join("")
    + `<button role="tab" data-tab="source" aria-selected="${current === "source"}">Library source</button>`
    + `<div class="right"><button id="export" title="Download this strategy as a .py file">Export</button><button id="import">Import</button><button id="delete">Delete</button></div>`;
  const own = current !== "source";
  $("export").hidden = !own; $("delete").hidden = !own || strategies.length === 1;
  $("check-btn").disabled = !ready || !view; $("play-btn").disabled = !ready || !view;
  $("check-actions").hidden = !own;
  $("source-pick").hidden = own;
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tab) openTab(b.dataset.tab);
  else if (b.id === "export") exportCurrent();
  else if (b.id === "import") $("import-file").click();
  else if (b.id === "delete") deleteCurrent();
});
function openTab(id) {
  current = id;
  if (id === "source") { drawTabs(); showSource(); return; }
  setDoc(strategies.find((s) => s.id === id).code, false);
  drawTabs();
  showCheck(null);
}
async function showSource() {
  if (!ready) { setDoc("# The library is still loading. Try again in a moment.", true); return; }
  const key = $("source-select").value || library[0]?.id;
  setDoc(key ? await call("source", { key }) : "", true);
}
$("source-select").addEventListener("change", showSource);

// A library strategy as the start of a new one: the class body with the
// imports its module gave it, and "_copy" on the name until it is renamed.
const COPY_HEADER = `import axelrod as axl
from axelrod.action import Action
from axelrod.player import Player

C, D = Action.C, Action.D


`;
$("copy-source").addEventListener("click", () => {
  if (!ready || !view) return;
  const lib = library.find((x) => x.id === $("source-select").value);
  let code = view.state.doc.toString();
  const named = code.match(/name = (["'])(.*?)\1/);
  if (named) code = code.replace(named[0], `name = ${named[1]}${named[2]}_copy${named[1]}`);
  const s = { id: "u" + Date.now().toString(36), name: `${lib.name}_copy`, code: COPY_HEADER + code };
  strategies.push(s); store.strategies = strategies;
  selected.add(s.id); store.selected = [...selected];
  drawMine(); drawOpponents(); openTab(s.id); drawEstimate();
});
function exportCurrent() {
  const s = strategies.find((x) => x.id === current);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([s.code], { type: "text/x-python" }));
  a.download = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") + ".py";
  a.click();
  URL.revokeObjectURL(a.href);
}
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const s = { id: "u" + Date.now().toString(36), name: file.name.replace(/\.py$/, ""), code: await file.text() };
  strategies.push(s); store.strategies = strategies;
  selected.add(s.id); store.selected = [...selected];
  drawMine(); drawOpponents(); openTab(s.id); drawEstimate();
  e.target.value = "";
});
function deleteCurrent() {
  const s = strategies.find((x) => x.id === current);
  if (!confirm(`Delete ${s.name}? This cannot be undone.`)) return;
  strategies = strategies.filter((x) => x !== s); store.strategies = strategies;
  selected.delete(s.id); store.selected = [...selected];
  drawMine(); drawOpponents(); openTab(strategies[0].id); drawEstimate();
}

// ---------- check ----------
async function define(s) {
  const info = await call("define", { uid: s.id, code: s.code });
  if (statusError) { statusError = null; drawEstimate(); }
  if (info.name !== s.name) { s.name = info.name; store.strategies = strategies; drawMine(); drawTabs(); drawOpponents(); }
  return info;
}
function showCheck(info, error) {
  const state = $("check-state"), body = $("check-body");
  if (error) {
    state.className = "state bad"; state.lastElementChild.textContent = "The strategy did not run.";
    body.innerHTML = `<pre>${esc(error)}</pre>`;
  } else if (info) {
    state.className = "state ok"; state.lastElementChild.textContent = `${info.name} compiled and played the smoke match.`;
    body.innerHTML = `<div class="tape" id="smoke"></div>
      <div class="facts num"><div><span>Score</span><span>${info.smoke.scores[0]} to ${info.smoke.scores[1]}</span></div><div><span>Stochastic</span><span>${info.stochastic ? "yes" : "no"}</span></div><div><span>Memory depth</span><span>${info.memory === null ? "unbounded" : info.memory}</span></div></div>`;
    drawTape($("smoke"), [info.name, info.smoke.opponent], info.smoke.moves, null, [true, false], { labels: false });
  } else {
    state.className = "state"; state.lastElementChild.textContent = "Not checked yet."; body.innerHTML = "";
  }
}
$("check-btn").addEventListener("click", async () => {
  const s = strategies.find((x) => x.id === current);
  try { showCheck(await define(s)); } catch (e) { showCheck(null, e.message); }
});
$("play-btn").addEventListener("click", async () => {
  const s = strategies.find((x) => x.id === current);
  const { turns, noise, seed } = settings();
  try {
    const info = await define(s);
    const opp = $("opponent").value;
    const oppSpec = strategies.some((x) => x.id === opp) ? { kind: "user", id: opp } : { kind: "lib", id: opp };
    if (oppSpec.kind === "user") await define(strategies.find((x) => x.id === opp));
    const m = await call("match", { a: { kind: "user", id: s.id }, b: oppSpec, turns, noise, seed });
    showCheck(info);
    tapeSel = { names: [info.name, nameOf(oppSpec)], moves: m.moves, scores: m.scores, mine: [true, oppSpec.kind === "user"], turns };
    if (result) drawMatrix();
    drawTapeCard();
    $("tape-card").scrollIntoView({ block: "nearest" });
  } catch (e) { showCheck(null, e.message); }
});
function nameOf(spec) {
  return spec.kind === "user" ? strategies.find((x) => x.id === spec.id).name : library.find((x) => x.id === spec.id).name;
}
function drawOpponents() {
  if (!ready) return;
  const sel = $("opponent"), was = sel.value;
  sel.innerHTML = strategies.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("") + library.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === was) ? was : "TitForTat";
  sel.disabled = false;
}

// ---------- tournament ----------
$("run").addEventListener("click", runTournament);
async function runTournament() {
  const specs = field();
  if (specs.length < 2) { status("Pick at least two strategies."); return; }
  const invalid = [...document.querySelectorAll(".topbar [data-setting]")].find((i) => !i.validity.valid);
  if (invalid) { status(`${invalid.parentElement.firstChild.textContent.trim()} must be between ${invalid.min} and ${invalid.max || "any number"}.`); return; }
  const opts = settings();
  running = true; $("run").disabled = true;
  const t0 = performance.now();
  try {
    for (const spec of specs.filter((s) => s.kind === "user")) {
      const s = strategies.find((x) => x.id === spec.id);
      try { await define(s); } catch (e) { openTab(s.id); showCheck(null, e.message); statusError = `${s.name} did not run. See the Check card.`; status(statusError); $("check").scrollIntoView({ block: "nearest" }); return; }
    }
    progress(0, 1); status("Playing the first match");
    const r = await call("tournament", { specs, ...opts }, ([done, total]) => { progress(done, total); status(`Match ${done} of ${total}`); });
    result = { ...r, specs, names: specs.map(nameOf), mine: specs.map((s) => s.kind === "user"), docs: specs.map((s) => (s.kind === "lib" ? library.find((x) => x.id === s.id).doc : "")), ...opts, seconds: (performance.now() - t0) / 1000 };
    const firstMine = result.mine.indexOf(true), leader = result.ranking[0];
    tapeSel = firstMine >= 0 && firstMine !== leader ? { i: firstMine, j: leader, rep: 0 } : { i: leader, j: result.ranking[1], rep: 0 };
    drawResults();
  } catch (e) {
    statusError = "The tournament failed."; status(statusError);
    $("results-empty").hidden = false; $("results-empty").textContent = e.message;
  } finally {
    progress(null); running = false; $("run").disabled = false; drawEstimate();
  }
}

// ---------- results ----------
const ordinal = (n) => ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][n - 1] || `${n}th`;
const f2 = (v) => v.toFixed(2);

function drawResults() {
  const r = result, n = r.names.length, rank = r.ranking;
  const by = (i) => esc(r.names[i]);
  const leader = rank[0];
  const mine = r.mine.indexOf(true);
  let finding;
  if (mine === leader) finding = `<b>Your strategy ${by(leader)} leads at ${f2(r.scores[leader])} a turn.</b>`;
  else finding = `<b>${by(leader)} leads at ${f2(r.scores[leader])} a turn.</b>`;
  if (mine >= 0) {
    const row = r.payoff[mine].map((v, j) => ({ v, j })).filter((x) => x.j !== mine);
    const worst = row.reduce((a, b) => (b.v < a.v ? b : a)), best = row.reduce((a, b) => (b.v > a.v ? b : a));
    if (mine !== leader) finding += ` ${by(mine)} is ${ordinal(rank.indexOf(mine) + 1)} at ${f2(r.scores[mine])}.`;
    finding += ` It does best against ${by(best.j)} (${f2(best.v)}) and worst against ${by(worst.j)} (${f2(worst.v)}).`;
  } else {
    const last = rank[n - 1];
    finding += ` ${by(last)} is last at ${f2(r.scores[last])}.`;
  }
  $("finding").innerHTML = finding;
  $("stamp").textContent = `${n} strategies · ${r.turns} turns · ${r.repetitions} repetition${r.repetitions === 1 ? "" : "s"}${r.noise ? ` · noise ${r.noise}` : ""} · seed ${r.seed} · ${r.seconds.toFixed(1)} s`;
  $("results-note").innerHTML = `Mean over ${r.repetitions} repetition${r.repetitions === 1 ? "" : "s"} of ${r.turns} turns. Mutual cooperation pays 3, mutual defection 1, a sucker 0 and a cheat 5. Rows are ranked by their mean; a column's number is the rank of that strategy. Hover or hold a name, a cell or a mean for details.`;
  $("results-empty").hidden = true;
  drawMatrix();
  drawTapeCard();
}

const measure = document.createElement("canvas").getContext("2d");
function textWidth(text, font) { measure.font = font; return measure.measureText(text).width; }
// cut from the middle so a distinguishing suffix survives ("Adaptive Pav…2011")
function clip(name, maxWidth, font) {
  if (textWidth(name, font) <= maxWidth) return name;
  let keep = name.length - 1;
  while (keep > 4 && textWidth(name.slice(0, Math.ceil(keep / 2)) + "…" + name.slice(-Math.floor(keep / 2)), font) > maxWidth) keep--;
  return name.slice(0, Math.ceil(keep / 2)) + "…" + name.slice(-Math.floor(keep / 2));
}
const firstParagraph = (doc) => doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ");

function drawMatrix() {
  const r = result, order = r.ranking, n = order.length;
  const host = $("matrix");
  const width = host.clientWidth || 1100;
  const narrow = width < 640, nameFont = "13px IBM Plex Sans, Inter, system-ui, sans-serif";
  // the name column fits the longest name up to a cap, and is never the column that loses width
  const nameMax = narrow ? 120 : 220;
  const label = 28 + Math.min(nameMax, Math.max(...r.names.map((x) => textWidth(x, nameFont)))) + 12;
  const scoreW = 52, gap = 24, minBar = 120;
  // on a phone the mean sits beside the names, so the leaderboard is in view while the cells scroll
  const cellsX = narrow ? label + scoreW + 12 : label;
  const cell = Math.max(28, Math.min(44, Math.floor((width - cellsX - (narrow ? 0 : gap + minBar + scoreW)) / n)));
  const w = Math.max(width, cellsX + n * cell + (narrow ? 0 : gap + minBar + scoreW));
  const barX = cellsX + n * cell + gap, barW = w - barX - scoreW - 12;
  const scoreX = narrow ? label + scoreW - 8 : w;
  const top = 24, h = top + n * cell;
  // light ramps so ink figures hold their contrast on every cell
  const fill = (v, mine) => mine ? `rgba(27,108,128,${0.08 + (v / 5) * 0.45})` : `rgba(19,20,22,${0.04 + (v / 5) * 0.3})`;
  const wins = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Payoff per turn of each strategy against each other, ranked">`;
  order.forEach((i, ri) => {
    const mine = r.mine[i], y = top + ri * cell, rankNo = ri + 1;
    const about = tipAttrs(r.names[i], r.mine[i] ? "Your strategy." : firstParagraph(r.docs[i]) || "From the Axelrod library.");
    const summary = tipAttrs(`${r.names[i]}: ${ordinal(rankNo)} of ${n}`, `${f2(r.scores[i])} a turn on average. Won ${wins(r.wins[i])} of ${n - 1} matches a repetition. Cooperated ${Math.round(100 * r.cooperation[i])}% of the time.`);
    // rows and columns share the rank order, so the rank number heads the column
    s += `<text x="4" y="${y + cell / 2 + 4}" font-size="12" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${rankNo}</text>`;
    s += `<text ${about} x="${label - 10}" y="${y + cell / 2 + 4}" text-anchor="end" font-size="13" fill="${mine ? ACCENT : INK}" font-weight="${mine ? 600 : 400}">${esc(clip(r.names[i], nameMax, nameFont))}</text>`;
    s += `<text ${about} x="${cellsX + ri * cell + cell / 2}" y="${top - 8}" text-anchor="middle" font-size="12" fill="${mine ? ACCENT : MUTED}" font-weight="${mine ? 600 : 400}" style="font-variant-numeric:tabular-nums">${rankNo}</text>`;
    order.forEach((j, ci) => {
      const v = r.payoff[i][j], on = tapeSel && tapeSel.i === i && tapeSel.j === j;
      const pair = i === j ? tipAttrs(`${r.names[i]} against itself`, `${f2(v)} a turn each.`) : tipAttrs(`${r.names[i]} against ${r.names[j]}`, `${f2(v)} a turn for ${r.names[i]}, ${f2(r.payoff[j][i])} for ${r.names[j]}. Select to see the tape.`);
      s += `<rect class="cell${on ? " on" : ""}" ${pair} tabindex="0" role="button" aria-label="${esc(r.names[i])} against ${esc(r.names[j])}, ${f2(v)} a turn" data-i="${i}" data-j="${j}" x="${cellsX + ci * cell + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="2" fill="${fill(v, mine || r.mine[j])}"/>`;
      s += `<text pointer-events="none" x="${cellsX + ci * cell + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="${cell < 34 ? 11 : 12}" fill="${INK}" style="font-variant-numeric:tabular-nums">${f2(v)}</text>`;
    });
    s += `<g ${summary}>`;
    if (narrow) {
      s += `<rect x="${label}" y="${y}" width="${scoreW}" height="${cell}" fill="transparent"/>`;
    } else {
      s += `<rect x="${barX}" y="${y}" width="${w - barX}" height="${cell}" fill="transparent"/>`;
      s += `<rect x="${barX}" y="${y + cell / 2 - 1}" width="${barW}" height="2" fill="#f0f1f2"/>`;
      s += `<rect x="${barX}" y="${y + cell / 2 - 1}" width="${(barW * r.scores[i]) / 5}" height="2" fill="${mine ? ACCENT : "#9aa0a3"}"/>`;
    }
    s += `<text x="${scoreX}" y="${y + cell / 2 + 4}" text-anchor="end" font-size="13" fill="${INK}" style="font-variant-numeric:tabular-nums">${f2(r.scores[i])}</text></g>`;
  });
  s += narrow
    ? `<text x="${scoreX}" y="${top - 8}" text-anchor="end" font-size="12" fill="${MUTED}">Mean</text>`
    : `<text x="${barX}" y="${top - 8}" font-size="12" fill="${MUTED}">Mean a turn, out of 5</text>`;
  s += `</svg>`;
  host.innerHTML = s;
}
function selectCell(c) {
  tapeSel = { i: +c.dataset.i, j: +c.dataset.j, rep: 0 };
  drawMatrix(); drawTapeCard();
}
$("matrix").addEventListener("keydown", (e) => {
  const c = e.target.closest("rect.cell");
  if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectCell(c); }
});
$("matrix").addEventListener("click", (e) => {
  if (heldTip) { heldTip = false; return; }   // a hold that showed the tooltip is not a tap
  const c = e.target.closest("rect.cell");
  if (c) selectCell(c);
});

// Details for the matrix: a tooltip on hover with a mouse, on a hold with a
// finger. The text is stored on the element as a title line and a body.
function tipAttrs(title, body) { return `data-tip-title="${esc(title)}" data-tip-body="${esc(body)}"`; }
const tip = $("tip");
let holdTimer = null, holdStart = null, heldTip = false;
function showTip(el, x, y, touch) {
  tip.innerHTML = `<b>${esc(el.dataset.tipTitle)}</b><div class="doc">${esc(el.dataset.tipBody)}</div>`;
  if (touch) heldTip = true;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  let left = touch ? x - width / 2 : x + 14, top = touch ? y - height - 28 : y + 14;
  if (left + width > vw - 8) left = vw - width - 8;
  if (left < 8) left = 8;
  if (top + height > vh - 8) top = y - height - 14;
  if (top < 8) top = touch ? y + 28 : 8;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}
function hideTip() { tip.hidden = true; clearTimeout(holdTimer); holdTimer = null; }
const matrix = $("matrix");
matrix.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const el = e.target.closest("[data-tip-title]");
  el ? showTip(el, e.clientX, e.clientY, false) : hideTip();
});
matrix.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") { if (!tip.hidden) { const el = e.target.closest("[data-tip-title]"); el && showTip(el, e.clientX, e.clientY, false); } return; }
  if (holdStart && Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > 8) hideTip();
});
matrix.addEventListener("pointerleave", hideTip);
matrix.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  const el = e.target.closest("[data-tip-title]");
  if (!el) return;
  heldTip = false;
  holdStart = { x: e.clientX, y: e.clientY };
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => showTip(el, e.clientX, e.clientY, true), 400);
});
for (const type of ["pointerup", "pointercancel"]) matrix.addEventListener(type, (e) => { if (e.pointerType !== "mouse") hideTip(); });
matrix.addEventListener("contextmenu", (e) => e.preventDefault());

function drawTapeCard() {
  const r = result;
  let names, moves, scores, mine, turns, reps = 1;
  if (tapeSel && "moves" in tapeSel) ({ names, moves, scores, mine, turns } = tapeSel);
  else if (tapeSel && r) {
    const { i, j, rep } = tapeSel;
    const key = i <= j ? `${i}:${j}:${rep}` : `${j}:${i}:${rep}`;
    const m = r.matches[key];
    const flip = i > j;
    names = [r.names[i], r.names[j]]; mine = [r.mine[i], r.mine[j]];
    moves = flip ? [m.moves[1], m.moves[0]] : m.moves;
    scores = flip ? [m.scores[1], m.scores[0]] : m.scores;
    turns = r.turns; reps = r.repetitions;
  } else { $("tape-empty").hidden = false; $("tape").innerHTML = ""; return; }
  $("tape-empty").hidden = true;
  $("tape-title").textContent = `${names[0]} against ${names[1]}`;
  const [a, b] = scores;
  const verdict = a === b ? "a draw" : a > b ? `${esc(names[0])} ahead by ${a - b}` : `${esc(names[1])} ahead by ${b - a}`;
  const coops = (moves[0] + moves[1]).split("").filter((c) => c === "C").length;
  $("tape-note").innerHTML = `${"moves" in tapeSel && r ? "A single match, not part of the tournament above · " : ""}${turns} turns · <b>${a} to ${b}</b>, ${verdict} · ${coops} of ${2 * turns} moves cooperated. Filled is cooperate, hollow is defect.`;
  $("reps-wrap").hidden = reps < 2;
  if (reps >= 2) $("reps").innerHTML = Array.from({ length: reps }, (_, k) => `<button aria-pressed="${k === tapeSel.rep}" data-rep="${k}" aria-label="Repetition ${k + 1}">${k + 1}</button>`).join("");
  drawTape($("tape"), names, moves, scores, mine, { labels: true });
}
$("reps").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  tapeSel.rep = +b.dataset.rep;
  drawTapeCard();
});

// Two strips of squares, one a turn. Filled teal is cooperate, hollow is
// defect. The names and scores stay put; only the strips scroll when a long
// match does not fit.
function drawTape(host, names, moves, scores, mine, { labels }) {
  host.innerHTML = labels
    ? `<div class="tape-grid"><div class="whos">${[0, 1].map((k) => `<span class="who${mine[k] ? " mine" : ""}" title="${esc(names[k])}">${esc(names[k])}</span>`).join("")}</div><div class="strips"></div><div class="scores num">${[0, 1].map((k) => `<span>${scores[k]}</span>`).join("")}</div></div>`
    : `<div class="tape-grid bare"><div class="strips"></div></div>`;
  const strips = host.querySelector(".strips");
  const n = moves[0].length;
  const sq = Math.max(3, Math.min(16, Math.floor(strips.clientWidth / n)));
  const w = n * sq, g = sq >= 8 ? 2 : 1;
  const row = (str) => {
    let s = `<svg viewBox="0 0 ${w} 20" width="${w}" height="20" aria-hidden="true">`;
    for (let t = 0; t < n; t++) {
      s += str[t] === "C"
        ? `<rect x="${t * sq}" y="2" width="${sq - g}" height="16" fill="${ACCENT}"/>`
        : `<rect x="${t * sq + 0.5}" y="2.5" width="${sq - g - 1}" height="15" fill="none" stroke="${INK}" stroke-width="1"/>`;
    }
    return s + `</svg>`;
  };
  strips.innerHTML = row(moves[0]) + row(moves[1]) + (labels ? `<div class="axis num" style="width:${w}px"><span>turn 1</span><span>turn ${n}</span></div>` : "");
  const cue = host.parentElement.querySelector(".tape-cue");
  if (cue) { const shown = Math.floor(strips.clientWidth / sq); cue.hidden = shown >= n; cue.textContent = `Turns 1 to ${shown} of ${n} are in view. Scroll the strips sideways for the rest.`; }
}

// ---------- boot ----------
drawMine(); drawTabs();
const editorOk = await mountEditor();
if (editorOk) openTab(current);
try {
  await booting;
  library = await call("library");
  $("lib-count").textContent = library.length;
  ready = true;
  document.body.classList.remove("loading");
  drawLibrary(); drawOpponents();
  $("source-select").innerHTML = library.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  $("source-select").value = "TitForTat";
  if (current === "source") showSource();
  progress(null); $("run").disabled = false; drawTabs(); drawEstimate();
} catch (e) {
  status("The Python runtime did not load. Reload to try again.");
  $("results-empty").textContent = e.message;
}
window.addEventListener("resize", () => { if (result) { drawMatrix(); } if (tapeSel) drawTapeCard(); });
