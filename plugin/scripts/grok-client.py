#!/usr/bin/env python3
"""Grok → claude-mem server-beta client write hook (packaged).

Installed by GrokHooksInstaller into ~/.grok/hooks/. Fail-open, no local
worker. Reads Grok hook JSON on stdin and POSTs to server-beta:

  POST /v1/sessions/start
  POST /v1/events
  POST /v1/sessions/:id/end

Settings: ~/.claude-mem/settings.json
  CLAUDE_MEM_SERVER_BETA_URL
  CLAUDE_MEM_SERVER_BETA_API_KEY

Project map cache: ~/.claude-mem/project-map.json
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

# --- constants ----------------------------------------------------------------

SETTINGS_PATH = Path.home() / ".claude-mem" / "settings.json"
PROJECT_MAP_PATH = Path.home() / ".claude-mem" / "project-map.json"
SESSIONS_ROOT = Path(os.environ.get("GROK_HOME", Path.home() / ".grok")) / "sessions"
PLATFORM_SOURCE = "grok"
TIMEOUT_SEC = 8
MAX_FIELD_CHARS = 6000
MAX_RESPONSE_CHARS = 2000

# Write-side tools only (handoff: skip read-only). Matcher also filters, but
# defense-in-depth if matcher is broadened later.
WRITE_TOOLS = frozenset(
    {
        "search_replace",
        "write",
        "run_terminal_command",
        # Claude/Cursor aliases Grok may still pass through
        "Edit",
        "Write",
        "MultiEdit",
        "Bash",
        "Shell",
    }
)

SECRET_RE = re.compile(
    r"(?i)("
    r"(?:api[_-]?key|token|secret|password|authorization|bearer|private[_-]?key)"
    r"\s*[:=]\s*['\"]?[^\s'\"]{8,}"
    r"|cmem_[A-Za-z0-9_-]{20,}"
    r"|sk-[A-Za-z0-9_-]{20,}"
    r"|ghp_[A-Za-z0-9]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{20,}"
    r")"
)


# --- fail-open entry ----------------------------------------------------------

def main() -> int:
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0  # fail-open

    try:
        cfg = load_settings()
        if not cfg:
            return 0
        handle(event, cfg)
    except Exception as exc:
        # Never block Grok; log to stderr for /hooks annotations.
        print(f"claude-mem-client: {exc}", file=sys.stderr)
        if os.environ.get("CLAUDE_MEM_GROK_DEBUG"):
            traceback.print_exc(file=sys.stderr)
    return 0


def handle(event: dict[str, Any], cfg: dict[str, str]) -> None:
    hook_event = (
        os.environ.get("GROK_HOOK_EVENT")
        or event.get("hookEventName")
        or ""
    ).lower().replace("-", "_")

    session_id = (
        os.environ.get("GROK_SESSION_ID")
        or event.get("sessionId")
        or event.get("session_id")
        or ""
    )
    cwd = (
        event.get("cwd")
        or event.get("workspaceRoot")
        or os.environ.get("GROK_WORKSPACE_ROOT")
        or os.environ.get("CLAUDE_PROJECT_DIR")
        or os.getcwd()
    )

    if not session_id:
        return

    project_id = resolve_project_id(cfg, cwd)
    if not project_id:
        return

    if hook_event == "session_start":
        start_session(cfg, project_id, session_id, cwd, None)
        return

    if hook_event == "user_prompt_submit":
        prompt = extract_user_prompt(event, session_id, cwd)
        start_session(cfg, project_id, session_id, cwd, prompt or None)
        if prompt:
            source_event_id = (
                event.get("promptId")
                or event.get("prompt_id")
                or str(uuid.uuid4())
            )
            record_event(
                cfg,
                project_id=project_id,
                session_id=session_id,
                event_type="user_prompt",
                payload={
                    "prompt": sanitize(prompt, MAX_FIELD_CHARS),
                    "promptId": event.get("promptId") or event.get("prompt_id"),
                    "cwd": cwd,
                    "platformSource": PLATFORM_SOURCE,
                },
                generate=False,
                source_event_id=str(source_event_id),
            )
        return

    if hook_event == "post_tool_use":
        tool_name = event.get("toolName") or event.get("tool_name") or ""
        if tool_name not in WRITE_TOOLS:
            return
        tool_input = event.get("toolInput") or event.get("tool_input") or {}
        tool_response = (
            event.get("toolResponse")
            or event.get("tool_response")
            or event.get("toolOutput")
            or event.get("result")
        )
        record_event(
            cfg,
            project_id=project_id,
            session_id=session_id,
            event_type="tool_use",
            payload={
                "tool_name": tool_name,
                "tool_input": sanitize(tool_input, MAX_FIELD_CHARS),
                "tool_response": sanitize(tool_response, MAX_RESPONSE_CHARS),
                "cwd": cwd,
                "platformSource": PLATFORM_SOURCE,
                "tool_use_id": event.get("toolUseId") or event.get("tool_use_id"),
            },
        )
        return

    if hook_event == "stop":
        # Mirror client summarize: durable assistant message, then end session
        # so server can enqueue session_summary generation.
        last_msg = extract_last_assistant_message(session_id, cwd, event)
        if last_msg:
            record_event(
                cfg,
                project_id=project_id,
                session_id=session_id,
                event_type="assistant_message",
                payload={
                    "last_assistant_message": sanitize(last_msg, MAX_FIELD_CHARS),
                    "platformSource": PLATFORM_SOURCE,
                },
            )
        try:
            started = start_session(cfg, project_id, session_id, cwd, None)
            sid = (started or {}).get("session", {}).get("id")
            if sid:
                end_session(cfg, sid)
        except Exception as exc:
            print(f"claude-mem-client: stop end: {exc}", file=sys.stderr)
        return

    if hook_event == "session_end":
        # Lifecycle close only — avoid re-recording the assistant message
        # (Stop already did that for the last turn).
        try:
            started = start_session(cfg, project_id, session_id, cwd, None)
            sid = (started or {}).get("session", {}).get("id")
            if sid:
                end_session(cfg, sid)
        except Exception as exc:
            print(f"claude-mem-client: session_end: {exc}", file=sys.stderr)
        return


# --- settings / project -------------------------------------------------------

def load_settings() -> dict[str, str] | None:
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    if isinstance(data.get("env"), dict):
        data = data["env"]
    url = (data.get("CLAUDE_MEM_SERVER_BETA_URL") or "").rstrip("/")
    key = data.get("CLAUDE_MEM_SERVER_BETA_API_KEY") or ""
    if not url or not key:
        return None
    return {"url": url, "key": key}


def project_name(cwd: str) -> str:
    """Match claude-mem getProjectName: owner/repo from origin, else basename."""
    try:
        root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).strip()
    except Exception:
        root = cwd
    try:
        origin = subprocess.check_output(
            ["git", "-C", root, "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).strip()
        owner_repo = parse_owner_repo(origin)
        if owner_repo:
            return owner_repo
    except Exception:
        pass
    base = Path(root).name or "unknown-project"
    return base


def parse_owner_repo(url: str) -> str | None:
    u = url.strip().removesuffix(".git")
    # git@host:owner/repo
    m = re.search(r"[:/]([^/]+)/([^/]+)$", u)
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}"


def load_project_map() -> dict[str, str]:
    try:
        return json.loads(PROJECT_MAP_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_project_map(cache: dict[str, str]) -> None:
    try:
        PROJECT_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
        PROJECT_MAP_PATH.write_text(
            json.dumps(cache, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(PROJECT_MAP_PATH, 0o600)
    except Exception:
        pass


def resolve_project_id(cfg: dict[str, str], cwd: str) -> str | None:
    name = project_name(cwd)
    cache = load_project_map()
    if name in cache:
        return cache[name]
    try:
        res = api_post(cfg, "/v1/projects/resolve", {"name": name})
        pid = res.get("id")
        if isinstance(pid, str) and pid:
            cache[name] = pid
            save_project_map(cache)
            return pid
    except Exception as exc:
        print(f"claude-mem-client: resolve {name}: {exc}", file=sys.stderr)
    return None


# --- API ----------------------------------------------------------------------

def api_post(cfg: dict[str, str], path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = f"{cfg['url']}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['key']}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")[:200]
        raise RuntimeError(f"HTTP {e.code} {path}: {text}") from e


def start_session(
    cfg: dict[str, str],
    project_id: str,
    session_id: str,
    cwd: str,
    prompt: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "projectId": project_id,
        "externalSessionId": session_id,
        "contentSessionId": session_id,
        "platformSource": PLATFORM_SOURCE,
        "metadata": {
            "project": project_name(cwd),
            "cwd": cwd,
        },
    }
    if prompt:
        body["metadata"]["prompt"] = sanitize(prompt, 2000)
    return api_post(cfg, "/v1/sessions/start", body)


def record_event(
    cfg: dict[str, str],
    *,
    project_id: str,
    session_id: str,
    event_type: str,
    payload: dict[str, Any],
    generate: bool = True,
    source_event_id: str | None = None,
) -> None:
    body = {
        "projectId": project_id,
        "contentSessionId": session_id,
        "sourceType": "hook",
        "eventType": event_type,
        "platformSource": PLATFORM_SOURCE,
        "occurredAtEpoch": int(time.time() * 1000),
        "sourceEventId": source_event_id or str(uuid.uuid4()),
        "payload": payload,
    }
    path = "/v1/events" if generate else "/v1/events?generate=false"
    api_post(cfg, path, body)


def end_session(cfg: dict[str, str], server_session_id: str) -> None:
    api_post(cfg, f"/v1/sessions/{server_session_id}/end", {})


# --- payload helpers ----------------------------------------------------------

def sanitize(value: Any, max_chars: int) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, default=str)
    else:
        text = str(value)
    text = SECRET_RE.sub("[REDACTED]", text)
    if len(text) > max_chars:
        text = text[:max_chars] + "…[truncated]"
    # Prefer structured when small enough
    if isinstance(value, (dict, list)) and len(text) <= max_chars and "…[truncated]" not in text:
        try:
            return json.loads(SECRET_RE.sub("[REDACTED]", json.dumps(value, ensure_ascii=False, default=str)))
        except Exception:
            return text
    return text


USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.DOTALL)


def unwrap_user_query(text: str) -> str:
    match = USER_QUERY_RE.search(text)
    return match.group(1).strip() if match else text.strip()


def extract_user_prompt(event: dict[str, Any], session_id: str, cwd: str) -> str:
    for key in ("prompt", "userPrompt", "user_prompt", "message", "query"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return unwrap_user_query(value)

    path = find_chat_history(session_id, cwd)
    if not path:
        return ""
    last = ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                if obj.get("synthetic_reason"):
                    continue
                text = unwrap_user_query(content_to_text(obj.get("content")))
                if text:
                    last = text
    except Exception:
        return last
    return last


def extract_last_assistant_message(
    session_id: str,
    cwd: str,
    event: dict[str, Any],
) -> str:
    direct = (
        event.get("lastAssistantMessage")
        or event.get("last_assistant_message")
        or event.get("assistantMessage")
        or event.get("response")
    )
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    # Fall back to on-disk Grok chat history
    path = find_chat_history(session_id, cwd)
    if not path:
        return ""
    last = ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "assistant":
                    continue
                content = obj.get("content")
                text = content_to_text(content)
                if text.strip():
                    last = text.strip()
    except Exception:
        return ""
    return last


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text" and "text" in block:
                    parts.append(str(block["text"]))
                elif "text" in block:
                    parts.append(str(block["text"]))
        return "\n".join(parts)
    if isinstance(content, dict):
        if "text" in content:
            return str(content["text"])
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def find_chat_history(session_id: str, cwd: str) -> Path | None:
    # Preferred: exact encoded-cwd layout
    from urllib.parse import quote

    encoded = quote(cwd, safe="")
    root = Path(SESSIONS_ROOT)
    candidate = root / encoded / session_id / "chat_history.jsonl"
    if candidate.is_file():
        return candidate
    # Search by session id (cwd encoding may differ)
    try:
        for p in root.glob(f"*/{session_id}/chat_history.jsonl"):
            return p
    except Exception:
        pass
    return None


if __name__ == "__main__":
    sys.exit(main())
