# Rapoport

**Axelrod's tournament, in your browser.** Write a Python strategy for the iterated prisoner's dilemma, run it round-robin against the classics, and watch every move.

Live at **https://justagist.github.io/rapoport/**

Rapoport is a static web app around the [Axelrod](https://github.com/Axelrod-Python/Axelrod) Python library. The library runs inside the visitor's browser through Pyodide, so the site needs no server and nothing a visitor writes leaves their computer. It is named after Anatol Rapoport, whose Tit For Tat won both of Robert Axelrod's tournaments; the name is a tribute, not an association.

## What it does

- A roster of the library's 240 strategies plus your own.
- An editor for your strategies, written the way the library defines them: a `Player` subclass with a `name`, a `classifier` and a `strategy(self, opponent)` method. A check compiles it and plays a smoke match against Tit For Tat.
- A round-robin tournament with a set number of turns, repetitions, optional noise and a seed. The result is the payoff matrix, ranked, and the move-by-move tape of every match.
- Your strategies stay in the browser and can be exported and imported as `.py` files.
- A progressive web app: the runtime is cached after the first visit, so later visits are quick and work offline.

## Everything runs on your computer

There is no server. The page is static files, and the Python that plays the matches runs inside your browser tab through Pyodide, in a background thread. Your strategies, your settings and every result stay in the browser; nothing is uploaded or sent anywhere, and the site keeps no account.

The price is a one-off download on the first visit of about 42 MB, mostly the scientific packages the Axelrod library imports:

| Component | Size |
| --- | --- |
| Pyodide core and standard library | 12.5 MB |
| scipy and openblas | 19.6 MB |
| pandas | 5.7 MB |
| numpy | 3.1 MB |
| Axelrod library, editor, fonts | about 1.5 MB |

The service worker keeps all of it, so the next visit loads from the cache, offline too. Starting the Python runtime and importing the library takes about 7 seconds each time the page opens, and about 10 seconds on the first visit.

## Run it locally

Any static server works. Pyodide needs a real origin rather than `file://`.

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Write a strategy

```python
import axelrod as axl
from axelrod.action import Action

C, D = Action.C, Action.D


class Probe(axl.Player):
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
        return D if opponent.history[-2:] == [D, D] else C
```

Inside `strategy`, `self.history` and `opponent.history` are the moves so far, `opponent.defections` counts theirs, and `self._random` is a seeded random source for stochastic strategies (set `"stochastic": True` in the classifier). The file must define exactly one `Player` subclass. The library's own strategies are readable from the "Library source" tab in the editor, and "Copy into a new strategy" starts one from any of them, with `_copy` on its name until you rename it. A few library strategies lean on helpers from their own module; a copy of those reports the missing name when checked.

## Layout

```
index.html, app.css, app.js   the arena
guide.html                    the guide: running a tournament, writing a strategy
background.html               the theory: the dilemma, Axelrod's tournaments, where it shows up, with sources
worker.js                     web worker: loads Pyodide and the library, answers engine commands
py/engine.py                  the Python side: library listing, user strategies, match, tournament
vendor/editor.js              the CodeMirror editor, bundled once from tools/editor-entry.js
sw.js, manifest.webmanifest   the progressive web app shell
tests/test_engine.py          pytest for the engine under CPython
tests/smoke.mjs               Playwright: runs a tournament in Chromium, then reloads offline
```

## Tests

The engine tests need the library under CPython:

```
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

The browser smoke test needs Node and a Chromium build (set `CHROME_PATH` if it is not the Playwright one):

```
npm install
npm run smoke
```

## Versions

The editor bundle is committed, so visitors and GitHub Pages need no build. To change CodeMirror's version, update `package.json` and run:

```
npm install
npm run build:editor
```

The library is pinned to 4.13.1. Release 4.14.0 imports PyTorch at module level for one strategy, which has no browser build.

## Licence

MIT. See `LICENSE`.
