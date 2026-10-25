import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))

import engine  # noqa: E402

PROBE = '''
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
'''


def test_library_lists_classics():
    names = {s["name"] for s in engine.library()}
    assert {"Tit For Tat", "Defector", "Cooperator", "Grudger", "phi", "pi", "e"} <= names
    tft = next(s for s in engine.library() if s["id"] == "TitForTat")
    assert tft["doc"].startswith("A player starts by cooperating") and "Names:" in tft["doc"]


def test_define_registers_and_smokes():
    info = engine.define("p1", PROBE)
    assert info["name"] == "Probe"
    assert info["smoke"]["scores"] == [59, 59]
    assert info["smoke"]["moves"] == ["D" + "C" * 19, "CD" + "C" * 18]
    assert info["memory"] == 2
    assert "p1" in engine.USER


def test_define_rejects_two_classes():
    with pytest.raises(ValueError, match="exactly one"):
        engine.define("bad", PROBE + "\nclass Second(Probe):\n    name = 'Second'\n")


def test_tournament_shape_and_known_payoffs():
    engine.define("p1", PROBE)
    specs = [
        {"kind": "lib", "id": "TitForTat"},
        {"kind": "lib", "id": "Defector"},
        {"kind": "lib", "id": "Cooperator"},
        {"kind": "user", "id": "p1"},
    ]
    seen = []
    r = engine.tournament(specs, turns=10, repetitions=2, noise=0, seed=3, progress=lambda d, t: seen.append((d, t)))
    assert seen[-1] == (20, 20)
    assert r["payoff"][2][1] == 0.0  # cooperator against defector
    assert r["payoff"][1][2] == 5.0
    assert r["payoff"][0][0] == 3.0  # tit for tat against itself
    assert r["ranking"][-1] == 2  # cooperator last: exploited by defector and probe
    assert set(r["matches"]) == {f"{i}:{j}:{k}" for i in range(4) for j in range(i, 4) for k in range(2)}
    assert r["matches"]["1:2:0"]["moves"] == ["D" * 10, "C" * 10]
    assert r["cooperation"][1] == 0.0 and r["cooperation"][2] == 1.0


def test_match_returns_moves():
    r = engine.match({"kind": "lib", "id": "TitForTat"}, {"kind": "lib", "id": "Defector"}, 5, 0, 1)
    assert r["moves"] == ["CDDDD", "DDDDD"]
    assert r["scores"] == [4, 9]
