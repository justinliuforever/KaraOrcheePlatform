"""Thread-safe verovio toolkit factory.

verovio.toolkit()'s default auto-init resolves its font/resource path in a way that
only works on the MAIN thread — constructed in a worker thread it silently fails to
load fonts and every loadFile/loadData returns False (hit by the preflight lane,
2026-07-07). toolkit(False) + an explicit resource path works on any thread.
"""
from __future__ import annotations
import os
import verovio

_RESOURCE_PATH = os.path.join(os.path.dirname(verovio.__file__), "data")


def make_toolkit() -> "verovio.toolkit":
    tk = verovio.toolkit(False)
    if not tk.setResourcePath(_RESOURCE_PATH):
        raise RuntimeError(f"verovio resource path failed to load: {_RESOURCE_PATH}")
    return tk


def version() -> str:
    return make_toolkit().getVersion()
