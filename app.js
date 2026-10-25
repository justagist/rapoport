// Rapoport: the arena page. Talks to the engine worker, keeps the visitor's
// strategies in localStorage and draws the matrix and the tapes.

// esm.sh resolves the shared @codemirror packages to one build each, so the
// editor, the Python mode and the state module share one instance.
import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { python } from "https://esm.sh/@codemirror/lang-python@6.1.7";
import { EditorState, Compartment } from "https://esm.sh/@codemirror/state@6";

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

// ---------- worker ----------
// The service worker must control the page before the runtime download
// starts, or the first files fetched are never cached for the next visit.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  try { await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready; } catch { /* the page works without it */ }
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
  });
}

// ---------- roster ----------
function drawMine() {
  $("mine").innerHTML = strategies.map((s) => `<li class="mine"><label><input type="checkbox" data-id="${s.id}" ${selected.has(s.id) ? "checked" : ""}><span>${esc(s.name)}</span></label></li>`).join("");
}
function drawLibrary() {
  const q = $("search").value.trim().toLowerCase();
  const rows = library.filter((s) => !q || s.name.toLowerCase().includes(q));
  $("lib").innerHTML = rows.map((s) => `<li><label><input type="checkbox" data-id="${s.id}" ${selected.has(s.id) ? "checked" : ""}><span title="${esc(s.doc)}">${esc(s.name)}</span></label>${s.slow ? '<span class="tag">slow</span>' : ""}</li>`).join("")
    || `<li><span class="tag">Nothing matches.</span></li>`;
}
$("search").addEventListener("input", drawLibrary);
document.querySelector(".roster").addEventListener("change", (e) => {
  const id = e.target.dataset?.id;
  if (!id) return;
  e.target.checked ? selected.add(id) : selected.delete(id);
  store.selected = [...selected];
});
$("new-strategy").addEventListener("click", () => {
  const s = { id: "u" + Date.now().toString(36), name: "Untitled", code: TEMPLATE.replace(/Probe/g, "MyStrategy") };
  strategies.push(s); store.strategies = strategies;
  selected.add(s.id); store.selected = [...selected];
  drawMine(); openTab(s.id); closeRoster();
});
$("menu").addEventListener("click", () => { const open = !$("roster").classList.contains("open"); $("roster").classList.toggle("open", open); $("menu").setAttribute("aria-expanded", String(open)); });
function closeRoster() { $("roster").classList.remove("open"); $("menu").setAttribute("aria-expanded", "false"); }
$("close-roster").addEventListener("click", closeRoster);

// ---------- editor ----------
const readOnly = new Compartment();
const view = new EditorView({
  parent: $("cm"),
  state: EditorState.create({ doc: "", extensions: [basicSetup, python(), readOnly.of([]), EditorView.updateListener.of((u) => { if (u.docChanged && current !== "source") saveCode(); })] }),
});
let saveTimer;
function saveCode() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = strategies.find((x) => x.id === current);
    if (s) { s.code = view.state.doc.toString(); store.strategies = strategies; }
  }, 300);
}
function setDoc(text, ro) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: readOnly.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
  $("cm").classList.toggle("readonly", ro);
}
function drawTabs() {
  $("tabs").innerHTML = strategies.map((s) => `<button role="tab" data-tab="${s.id}" aria-selected="${current === s.id}">${esc(s.name)}</button>`).join("")
    + `<button role="tab" data-tab="source" aria-selected="${current === "source"}">Library source</button>`
    + `<div class="right"><button id="export" title="Download this strategy as a .py file">Export</button><button id="import">Import</button><button id="delete">Delete</button></div>`;
  const own = current !== "source";
  $("export").hidden = !own; $("delete").hidden = !own || strategies.length === 1;
  $("check-btn").disabled = !ready || !own; $("play-btn").disabled = !ready || !own;
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
  const key = $("source-select").value || library[0]?.id;
  setDoc(key ? await call("source", { key }) : "", true);
}
$("source-select").addEventListener("change", showSource);
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
  drawMine(); openTab(s.id);
  e.target.value = "";
});
function deleteCurrent() {
  const s = strategies.find((x) => x.id === current);
  if (!confirm(`Delete ${s.name}? This cannot be undone.`)) return;
  strategies = strategies.filter((x) => x !== s); store.strategies = strategies;
  selected.delete(s.id); store.selected = [...selected];
  drawMine(); openTab(strategies[0].id);
}

// ---------- check ----------
async function define(s) {
  const info = await call("define", { uid: s.id, code: s.code });
  if (info.name !== s.name) { s.name = info.name; store.strategies = strategies; drawMine(); drawTabs(); }
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
    const oppSpec = opp.startsWith("u") && strategies.some((x) => x.id === opp) ? { kind: "user", id: opp } : { kind: "lib", id: opp };
    if (oppSpec.kind === "user") await define(strategies.find((x) => x.id === opp));
    const m = await call("match", { a: { kind: "user", id: s.id }, b: oppSpec, turns, noise, seed });
    showCheck(info);
    tapeSel = { names: [info.name, nameOf(oppSpec)], moves: m.moves, scores: m.scores, mine: [true, oppSpec.kind === "user"], turns };
    drawTapeCard();
    $("tape-card").scrollIntoView({ block: "nearest" });
  } catch (e) { showCheck(null, e.message); }
});
function nameOf(spec) {
  return spec.kind === "user" ? strategies.find((x) => x.id === spec.id).name : library.find((x) => x.id === spec.id).name;
}
function drawOpponents() {
  const sel = $("opponent");
  sel.innerHTML = strategies.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("") + library.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  sel.value = "TitForTat";
}

// ---------- tournament ----------
$("run").addEventListener("click", runTournament);
async function runTournament() {
  const specs = [...strategies.filter((s) => selected.has(s.id)).map((s) => ({ kind: "user", id: s.id })),
                 ...library.filter((s) => selected.has(s.id)).map((s) => ({ kind: "lib", id: s.id }))];
  if (specs.length < 2) { status("Pick at least two strategies."); return; }
  const opts = settings();
  $("run").disabled = true;
  const t0 = performance.now();
  try {
    for (const spec of specs.filter((s) => s.kind === "user")) {
      const s = strategies.find((x) => x.id === spec.id);
      try { await define(s); } catch (e) { openTab(s.id); showCheck(null, e.message); status(`${s.name} did not run.`); return; }
    }
    progress(0, 1); status("Playing the first match");
    const r = await call("tournament", { specs, ...opts }, ([done, total]) => { progress(done, total); status(`Match ${done} of ${total}`); });
    result = { ...r, specs, names: specs.map(nameOf), mine: specs.map((s) => s.kind === "user"), ...opts, seconds: (performance.now() - t0) / 1000 };
    const firstMine = result.mine.indexOf(true), leader = result.ranking[0];
    tapeSel = firstMine >= 0 && firstMine !== leader ? { i: firstMine, j: leader, rep: 0 } : { i: leader, j: result.ranking[1], rep: 0 };
    drawResults();
    status("");
  } catch (e) {
    status("The tournament failed.");
    $("results-empty").hidden = false; $("results-empty").textContent = e.message;
  } finally {
    progress(null); $("run").disabled = false;
  }
}
function status(text) { $("status").textContent = text; }
function progress(done, total) {
  const el = $("progress");
  el.hidden = done === null;
  if (done !== null) el.firstElementChild.style.width = `${(100 * done) / total}%`;
}

// ---------- results ----------
const ordinal = (n) => ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][n - 1] || `${n}th`;
const f2 = (v) => v.toFixed(2);

function drawResults() {
  const r = result, n = r.names.length, rank = r.ranking;
  const by = (i) => r.names[i];
  const leader = rank[0];
  let finding = `<b>${esc(by(leader))} leads at ${f2(r.scores[leader])} a turn.</b>`;
  const mine = r.mine.indexOf(true);
  if (mine >= 0) {
    const pos = rank.indexOf(mine) + 1;
    const row = r.payoff[mine].map((v, j) => ({ v, j })).filter((x) => x.j !== mine);
    const worst = row.reduce((a, b) => (b.v < a.v ? b : a)), best = row.reduce((a, b) => (b.v > a.v ? b : a));
    finding += mine === leader ? ` It is your strategy.` : ` ${esc(by(mine))} is ${ordinal(pos)} at ${f2(r.scores[mine])}.`;
    finding += ` It does best against ${esc(by(best.j))} (${f2(best.v)}) and worst against ${esc(by(worst.j))} (${f2(worst.v)}).`;
  } else {
    const last = rank[n - 1];
    finding += ` ${esc(by(last))} is last at ${f2(r.scores[last])}.`;
  }
  $("finding").innerHTML = finding;
  $("stamp").textContent = `${n} strategies · ${r.turns} turns · ${r.repetitions} repetition${r.repetitions === 1 ? "" : "s"}${r.noise ? ` · noise ${r.noise}` : ""} · seed ${r.seed} · ${r.seconds.toFixed(1)} s`;
  $("results-note").innerHTML = `Mean over ${r.repetitions} repetition${r.repetitions === 1 ? "" : "s"} of ${r.turns} turns. Mutual cooperation pays 3, mutual defection 1, a sucker 0 and a cheat 5. Rows are ranked by their mean.`;
  $("results-empty").hidden = true;
  drawMatrix();
  drawTapeCard();
}

function drawMatrix() {
  const r = result, order = r.ranking, n = order.length;
  const host = $("matrix");
  const width = host.clientWidth || 1100;
  const narrow = width < 520, label = narrow ? 112 : 150, scoreW = 52, gap = 24, minBar = 120;
  const cell = Math.max(28, Math.min(44, Math.floor((width - label - gap - minBar - scoreW) / n)));
  // the mean bar takes whatever width the cells leave, so the figure ends on the card's edge
  const w = Math.max(width, label + n * cell + gap + minBar + scoreW);
  const barX = label + n * cell + gap, barW = w - barX - scoreW - 12;
  const top = 24, h = top + n * cell;
  // light ramps so ink figures hold their contrast on every cell
  const fill = (v, mine) => mine ? `rgba(27,108,128,${0.08 + (v / 5) * 0.45})` : `rgba(19,20,22,${0.04 + (v / 5) * 0.3})`;
  const max = narrow ? 13 : 18, short = (name) => (name.length > max ? name.slice(0, max - 1) + "…" : name);
  const initials = (name) => name.split(/[\s-]+/).map((p) => p[0]).join("").slice(0, 3);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Payoff per turn of each strategy against each other, ranked">`;
  order.forEach((i, ri) => {
    const mine = r.mine[i], col = mine ? ACCENT : MUTED, y = top + ri * cell;
    s += `<text x="${label - 10}" y="${y + cell / 2 + 4}" text-anchor="end" font-size="13" fill="${mine ? ACCENT : INK}" font-weight="${mine ? 600 : 400}">${esc(short(r.names[i]))}</text>`;
    s += `<text x="${label + ri * cell + cell / 2}" y="${top - 8}" text-anchor="middle" font-size="12" fill="${col}" font-weight="${mine ? 600 : 400}">${esc(initials(r.names[i]))}</text>`;
    order.forEach((j, ci) => {
      const v = r.payoff[i][j], on = tapeSel && tapeSel.i === i && tapeSel.j === j;
      s += `<rect class="cell${on ? " on" : ""}" data-i="${i}" data-j="${j}" x="${label + ci * cell + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="2" fill="${fill(v, mine || r.mine[j])}"><title>${esc(r.names[i])} against ${esc(r.names[j])}: ${f2(v)} a turn</title></rect>`;
      s += `<text pointer-events="none" x="${label + ci * cell + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="12" fill="${INK}" style="font-variant-numeric:tabular-nums">${f2(v)}</text>`;
    });
    s += `<rect x="${barX}" y="${y + cell / 2 - 1}" width="${barW}" height="2" fill="#f0f1f2"/>`;
    s += `<rect x="${barX}" y="${y + cell / 2 - 1}" width="${(barW * r.scores[i]) / 5}" height="2" fill="${mine ? ACCENT : "#9aa0a3"}"/>`;
    s += `<text x="${w}" y="${y + cell / 2 + 4}" text-anchor="end" font-size="13" fill="${INK}" style="font-variant-numeric:tabular-nums">${f2(r.scores[i])}</text>`;
  });
  s += `<text x="${barX}" y="${top - 8}" font-size="12" fill="${MUTED}">Mean a turn, out of 5</text>`;
  s += `</svg>`;
  host.innerHTML = s;
}
$("matrix").addEventListener("click", (e) => {
  const c = e.target.closest("rect.cell");
  if (!c) return;
  tapeSel = { i: +c.dataset.i, j: +c.dataset.j, rep: 0 };
  drawMatrix(); drawTapeCard();
});

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
  const verdict = a === b ? "a draw" : a > b ? `${names[0]} ahead by ${a - b}` : `${names[1]} ahead by ${b - a}`;
  $("tape-note").innerHTML = `${turns} turns · <b>${a} to ${b}</b>, ${verdict} · ${moves[0].split("").filter((c) => c === "C").length + moves[1].split("").filter((c) => c === "C").length} of ${2 * turns} moves cooperated. Filled is cooperate, hollow is defect.`;
  const reps_el = $("reps");
  reps_el.hidden = reps < 2;
  if (reps >= 2) reps_el.innerHTML = Array.from({ length: reps }, (_, k) => `<button aria-pressed="${k === tapeSel.rep}" data-rep="${k}" aria-label="Repetition ${k + 1}">${k + 1}</button>`).join("");
  drawTape($("tape"), names, moves, scores, mine, { labels: true });
}
$("reps").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  tapeSel.rep = +b.dataset.rep;
  drawTapeCard();
});

// Two rows of squares, one a turn. Filled teal is cooperate, hollow is defect.
function drawTape(host, names, moves, scores, mine, { labels }) {
  const n = moves[0].length;
  const avail = host.clientWidth - (labels ? 152 + 60 : 0);
  const sq = Math.max(4, Math.min(16, Math.floor(avail / n)));
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
  host.innerHTML = [0, 1].map((k) => `<div class="row">${labels ? `<span class="who${mine[k] ? " mine" : ""}" title="${esc(names[k])}">${esc(names[k])}</span>` : ""}${row(moves[k])}${labels ? `<span class="score num">${scores[k]}</span>` : ""}</div>`).join("")
    + (labels ? `<div class="axis num" style="width:${w}px"><span>turn 1</span><span>turn ${n}</span></div>` : "");
}

// ---------- boot ----------
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

drawMine(); drawTabs();
setDoc(strategies.find((s) => s.id === current).code, false);
try {
  await call("init", {}, ([done, total], label) => { status(`${label} (${done + 1} of ${total})`); progress(done, total); });
  library = await call("library");
  $("lib-count").textContent = library.length;
  drawLibrary(); drawOpponents();
  $("source-select").innerHTML = library.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  $("source-select").value = "TitForTat";
  ready = true;
  progress(null); status(""); $("run").disabled = false; drawTabs();
} catch (e) {
  status("The Python runtime did not load. Reload to try again.");
  $("results-empty").textContent = e.message;
}
window.addEventListener("resize", () => { if (result) { drawMatrix(); } if (tapeSel) drawTapeCard(); });
