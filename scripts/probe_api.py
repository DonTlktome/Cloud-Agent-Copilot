"""Probe which wire formats an LLM endpoint supports.

Usage (PowerShell / bash):
    python scripts/probe_api.py <BASE_URL ending in /v1> <API_KEY> <MODEL>

Only the Python standard library is used. The key is never written anywhere.
"""
import json
import sys
import urllib.error
import urllib.request

if len(sys.argv) != 4:
    print(__doc__)
    sys.exit(1)

BASE, KEY, MODEL = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]


def call(name, path, body=None, headers=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode("utf-8", "replace")
            print(f"[OK  {r.status}] {name}: {text[:400]}")
            return True, text
    except urllib.error.HTTPError as e:
        print(f"[ERR {e.code}] {name}: {e.read().decode('utf-8', 'replace')[:400]}")
    except Exception as e:  # noqa: BLE001
        print(f"[ERR ---] {name}: {e}")
    return False, ""


bearer = {"authorization": f"Bearer {KEY}"}
anthropic = {"x-api-key": KEY, "authorization": f"Bearer {KEY}", "anthropic-version": "2023-06-01"}
tool = {
    "name": "get_time",
    "description": "Return the current time",
    "input_schema": {"type": "object", "properties": {"tz": {"type": "string"}}, "required": ["tz"]},
}

results = {}
results["models"] = call("GET /models", "/models", headers=bearer)[0]
results["messages"] = call(
    "POST /messages (Anthropic)",
    "/messages",
    {"model": MODEL, "max_tokens": 64, "messages": [{"role": "user", "content": "say hi"}]},
    anthropic,
)[0]
if results["messages"]:
    results["messages_tools"] = call(
        "POST /messages + tools",
        "/messages",
        {
            "model": MODEL,
            "max_tokens": 200,
            "tools": [tool],
            "messages": [{"role": "user", "content": "What time is it in UTC? Use the tool."}],
        },
        anthropic,
    )[0]
results["chat"] = call(
    "POST /chat/completions (OpenAI)",
    "/chat/completions",
    {"model": MODEL, "max_tokens": 64, "messages": [{"role": "user", "content": "say hi"}]},
    bearer,
)[0]
if results["chat"]:
    results["chat_tools"] = call(
        "POST /chat/completions + tools",
        "/chat/completions",
        {
            "model": MODEL,
            "max_tokens": 200,
            "tools": [{"type": "function", "function": {"name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]}}],
            "messages": [{"role": "user", "content": "What time is it in UTC? Use the tool."}],
        },
        bearer,
    )[0]
results["responses"] = call(
    "POST /responses (OpenAI Responses)",
    "/responses",
    {"model": MODEL, "input": "say hi", "max_output_tokens": 64},
    bearer,
)[0]

print("\nSUMMARY:", json.dumps(results))
if results.get("messages"):
    print("=> Anthropic format works: Claude Code can connect directly (ANTHROPIC_BASE_URL = base without /v1).")
elif results.get("chat"):
    print("=> Only OpenAI chat format: use the LiteLLM proxy profile (docker compose --profile proxy).")
elif results.get("responses"):
    print("=> Only Responses format: Codex could connect directly; Claude Code needs a proxy.")
