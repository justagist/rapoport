"""Python side of Rapoport: a thin wrapper over the Axelrod library.

Runs inside Pyodide in a web worker. Every public function takes and
returns plain data so the JavaScript side can pass it through JSON.
"""

import random

import axelrod as axl

LIBRARY = {cls.__name__: cls for cls in axl.strategies}
USER = {}


def library():
    """Describe every ordinary strategy in the Axelrod library."""
    out = []
    for key, cls in LIBRARY.items():
        out.append(
            {
                "id": key,
                # three strategies carry LaTeX names for the library's plots
                "name": cls.name.replace("$", "").replace("\\", ""),
                "stochastic": bool(cls.classifier.get("stochastic")),
                "slow": bool(cls.classifier.get("long_run_time")),
                "doc": (cls.__doc__ or "").strip().split("\n")[0],
            }
        )
    out.sort(key=lambda s: s["name"].lower())
    return out


def source(key):
    """Return the library source of one strategy class."""
    import inspect

    return inspect.getsource(LIBRARY[key])


def define(uid, code):
    """Compile user code and register the single Player subclass it defines.

    Raises ValueError with a readable message when the code does not
    define exactly one strategy or the strategy cannot play a match.
    """
    module_name = f"user_{uid}"
    ns = {"__name__": module_name}
    exec(compile(code, f"{module_name}.py", "exec"), ns)
    classes = [
        v
        for v in ns.values()
        if isinstance(v, type) and issubclass(v, axl.Player) and v.__module__ == module_name
    ]
    if len(classes) != 1:
        raise ValueError(
            f"Expected exactly one axelrod.Player subclass, found {len(classes)}."
        )
    cls = classes[0]
    match = axl.Match((cls(), axl.TitForTat()), turns=20, seed=1)
    match.play()
    USER[uid] = cls
    depth = cls.classifier.get("memory_depth")
    return {
        "name": cls.name,
        "stochastic": bool(cls.classifier.get("stochastic")),
        "memory": None if depth in (None, float("inf")) else depth,
        "smoke": {
            "opponent": "Tit For Tat",
            "turns": 20,
            "moves": ["".join(str(x) for x in p.history) for p in match.players],
            "scores": [int(x) for x in match.final_score()],
        },
    }


def _resolve(spec):
    if spec["kind"] == "user":
        return USER[spec["id"]]
    return LIBRARY[spec["id"]]


def match(a, b, turns, noise, seed):
    """Play one match and return both histories and the final scores."""
    players = (_resolve(a)(), _resolve(b)())
    m = axl.Match(players, turns=turns, noise=noise, seed=seed)
    m.play()
    return {
        "moves": ["".join(str(x) for x in p.history) for p in players],
        "scores": [int(x) for x in m.final_score()],
    }


def tournament(specs, turns, repetitions, noise, seed, progress=None):
    """Round-robin including self-play, with every match's moves kept.

    Returns per-turn payoff matrix (row against column), ranking,
    cooperation rates, win counts and the move strings of every match.
    """
    classes = [_resolve(s) for s in specs]
    n = len(classes)
    rng = random.Random(seed)
    pairs = [(i, j) for i in range(n) for j in range(i, n)]
    total = len(pairs) * repetitions
    done = 0
    payoff = [[0.0] * n for _ in range(n)]
    coops = [0] * n
    plays = [0] * n
    wins = [0] * n
    matches = {}
    for i, j in pairs:
        for rep in range(repetitions):
            players = (classes[i](), classes[j]())
            m = axl.Match(players, turns=turns, noise=noise, seed=rng.randrange(2**31))
            m.play()
            sa, sb = (int(x) for x in m.final_score())
            ha = "".join(str(x) for x in players[0].history)
            hb = "".join(str(x) for x in players[1].history)
            matches[f"{i}:{j}:{rep}"] = {"moves": [ha, hb], "scores": [sa, sb]}
            payoff[i][j] += sa / turns
            coops[i] += ha.count("C")
            plays[i] += turns
            if i != j:
                payoff[j][i] += sb / turns
                coops[j] += hb.count("C")
                plays[j] += turns
                if sa > sb:
                    wins[i] += 1
                elif sb > sa:
                    wins[j] += 1
            else:
                payoff[i][i] += sb / turns
                coops[i] += hb.count("C")
                plays[i] += turns
            done += 1
            if progress is not None:
                progress(done, total)
    for i in range(n):
        for j in range(n):
            payoff[i][j] /= repetitions * (2 if i == j else 1)
    scores = [sum(row) / n for row in payoff]
    ranking = sorted(range(n), key=lambda i: -scores[i])
    return {
        "payoff": payoff,
        "scores": scores,
        "ranking": ranking,
        "cooperation": [coops[i] / plays[i] for i in range(n)],
        "wins": [w / repetitions for w in wins],
        "matches": matches,
    }
