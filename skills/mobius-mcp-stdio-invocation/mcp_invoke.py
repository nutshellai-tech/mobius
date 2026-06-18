#!/usr/bin/env python3
"""Generic MCP stdio JSON-RPC client.

Spawn any stdio MCP server, run the initialize handshake, and call a tool.
Tested with `uvx --from minimax-coding-plan-mcp minimax-coding-plan-mcp -y`
but the spawn command and tool name are parameters — works for any stdio MCP.

Usage:
    python3 mcp_invoke.py                      # runs the built-in example
    python3 mcp_invoke.py list                 # print tools/list and exit
    python3 mcp_invoke.py call <tool> <json>   # call <tool> with <json-args>
"""
import json, os, subprocess, sys, time, select, argparse

# --- Config: edit these for your MCP server ---------------------------------
COMMAND = ["uvx", "--from", "minimax-coding-plan-mcp", "minimax-coding-plan-mcp", "-y"]
ENV_OVERRIDES = {
    # Required by MiniMax MCP; replace with your server's env vars
    "MINIMAX_API_KEY": "REPLACE_ME",
    "MINIMAX_API_HOST": "https://api.minimaxi.com",
    "MINIMAX_MCP_BASE_PATH": "/tmp/mcp-out",
    "MINIMAX_API_RESOURCE_MODE": "url",
}
PROTOCOL_VERSION = "2024-11-05"  # adjust if the server wants a different one
# ---------------------------------------------------------------------------

DEFAULT_TOOL = "web_search"
DEFAULT_ARGS = {"query": "today top news 2026-06-10"}


class MCPError(Exception):
    pass


def _spawn():
    env = os.environ.copy()
    env.update({k: v for k, v in ENV_OVERRIDES.items() if v and v != "REPLACE_ME"})
    if ENV_OVERRIDES.get("MINIMAX_MCP_BASE_PATH"):
        os.makedirs(ENV_OVERRIDES["MINIMAX_MCP_BASE_PATH"], exist_ok=True)
    return subprocess.Popen(
        COMMAND,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, text=True, bufsize=1,
    )


def _send(proc, req):
    proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
    proc.stdin.flush()


def _recv(proc, *, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            line = proc.stdout.readline()
            if line:
                return json.loads(line)
    raise MCPError(f"no MCP response within {timeout}s; stderr tail: {proc.stderr.read1(2000)!r}")


def _init(proc):
    _send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "mcp_invoke.py", "version": "0.1.0"},
    }})
    init = _recv(proc)
    if "error" in init:
        raise MCPError(f"initialize failed: {init['error']}")
    _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    return init["result"].get("serverInfo", {})


def call_tool(name, arguments, *, timeout=60):
    proc = _spawn()
    try:
        _init(proc)
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": name, "arguments": arguments,
        }})
        return _recv(proc, timeout=timeout)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def list_tools():
    proc = _spawn()
    try:
        _init(proc)
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        return _recv(proc)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("list", help="call tools/list and print tool names + descriptions")
    c = sub.add_parser("call", help="call tools/call with given JSON arguments")
    c.add_argument("tool")
    c.add_argument("args_json", help='e.g. \'{"query":"hello"}\'')
    args = ap.parse_args()

    if args.cmd == "list":
        result = list_tools()
        for t in result["result"]["tools"]:
            print(f"- {t['name']}")
            desc = (t.get("description") or "").strip().splitlines()[0][:100]
            if desc:
                print(f"    {desc}")
        return

    if args.cmd == "call":
        result = call_tool(args.tool, json.loads(args.args_json))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # default: run the example
    print(f">>> calling {DEFAULT_TOOL}({DEFAULT_ARGS}) via {COMMAND}", file=sys.stderr)
    result = call_tool(DEFAULT_TOOL, DEFAULT_ARGS)
    text = result["result"]["content"][0]["text"]
    try:
        print(json.dumps(json.loads(text), ensure_ascii=False, indent=2))
    except json.JSONDecodeError:
        print(text)


if __name__ == "__main__":
    main()
