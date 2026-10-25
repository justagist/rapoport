// Engine worker: loads Pyodide and the Axelrod library, then answers commands.
//
// Request:  {id, cmd, args}
// Reply:    {id, ok: true, result} or {id, ok: false, error}
// Progress: {id, progress: [done, total], label}
//
// `init` must be sent first; every other command maps to a function of the
// same name in py/engine.py.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";
const AXELROD = "axelrod==4.13.1";
// Wheels the library imports at top level, loaded one by one so the page can
// show progress through the 50 MB download.
const WHEELS = ["numpy", "scipy", "pandas", "matplotlib", "pyyaml", "tqdm", "cloudpickle", "toolz", "fsspec"];

importScripts(PYODIDE + "pyodide.js");

let py = null;
let engine = null;

async function init(id) {
  const steps = WHEELS.length + 3;
  let done = 0;
  const step = (label) => postMessage({ id, progress: [done++, steps], label });

  step("Loading the Python runtime");
  py = await loadPyodide({ indexURL: PYODIDE });
  for (const w of WHEELS) {
    step(`Fetching ${w}`);
    await py.loadPackage(w, { messageCallback: () => {} });
  }
  step("Installing the Axelrod library");
  await py.loadPackage("micropip", { messageCallback: () => {} });
  await py.runPythonAsync(`import micropip\nawait micropip.install("${AXELROD}")`);
  step("Starting the engine");
  const src = await (await fetch("py/engine.py")).text();
  py.FS.writeFile("/home/pyodide/engine.py", src);
  engine = py.pyimport("engine");
  return { version: py.runPython("import axelrod; axelrod.__version__") };
}

function toJs(value) {
  return value && typeof value.toJs === "function"
    ? value.toJs({ dict_converter: Object.fromEntries })
    : value;
}

async function run(id, cmd, args) {
  if (cmd === "init") return init(id);
  if (!engine) throw new Error("Engine not initialised");
  if (cmd === "tournament") {
    args = { ...args, progress: (done, total) => postMessage({ id, progress: [done, total] }) };
  }
  // Nested objects and arrays must become dicts and lists, not JS proxies.
  const kwargs = {};
  for (const [k, v] of Object.entries(args)) kwargs[k] = typeof v === "function" ? v : py.toPy(v);
  const result = engine[cmd].callKwargs(kwargs);
  try {
    return toJs(result);
  } finally {
    if (result && typeof result.destroy === "function") result.destroy();
  }
}

onmessage = async ({ data: { id, cmd, args } }) => {
  try {
    postMessage({ id, ok: true, result: await run(id, cmd, args || {}) });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e.message || e) });
  }
};
