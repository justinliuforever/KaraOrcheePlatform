"""Raw-REST LLM callers (no SDKs — version pins burned the ASR spike).

claude-sonnet-5 primary: on real lessons it missed 2.7x fewer instructions than
DeepSeek-Pro, and missed content is the one failure a 2-minute teacher review
cannot catch. deepseek-v4-pro = availability fallback for beta (GA revisits the
processor via a US-hosted deployment).
"""
from __future__ import annotations

import os
import time

import requests


class LLMResult:
    def __init__(self, text: str, in_tok: int, out_tok: int, secs: float, model: str):
        self.text = text
        self.in_tok = in_tok
        self.out_tok = out_tok
        self.secs = secs
        self.model = model


def call_claude(system: str, user: str, max_tokens: int = 16000) -> LLMResult:
    key = os.environ["ANTHROPIC_API_KEY"]
    t0 = time.time()
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": "claude-sonnet-5", "max_tokens": max_tokens,
              "system": system, "messages": [{"role": "user", "content": user}]},
        timeout=600,
    )
    r.raise_for_status()
    j = r.json()
    u = j.get("usage", {})
    text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
    return LLMResult(text, u.get("input_tokens", 0), u.get("output_tokens", 0),
                     round(time.time() - t0, 1), "claude-sonnet-5")


def call_deepseek(system: str, user: str, max_tokens: int = 16000) -> LLMResult:
    key = os.environ["DEEPSEEK_API_KEY"]
    t0 = time.time()
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": "deepseek-v4-pro", "max_tokens": max_tokens, "temperature": 0.2,
              "messages": [{"role": "system", "content": system},
                           {"role": "user", "content": user}]},
        timeout=600,
    )
    r.raise_for_status()
    j = r.json()
    u = j.get("usage", {})
    return LLMResult(j["choices"][0]["message"].get("content") or "",
                     u.get("prompt_tokens", 0), u.get("completion_tokens", 0),
                     round(time.time() - t0, 1), "deepseek-v4-pro")


def generate(system: str, user: str) -> LLMResult:
    """Primary with one retry, then fallback if configured."""
    last: Exception | None = None
    for _ in range(2):
        try:
            return call_claude(system, user)
        except Exception as err:  # noqa: BLE001 — availability fallback by design
            last = err
            time.sleep(5)
    if os.environ.get("DEEPSEEK_API_KEY"):
        return call_deepseek(system, user)
    raise RuntimeError(f"llm unavailable: {last}")
