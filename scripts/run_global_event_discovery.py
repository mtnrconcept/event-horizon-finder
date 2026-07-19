#!/usr/bin/env python3
"""Operate the bounded worldwide event-discovery workers.

The client only uses Python's standard library. It calls the protected
``global-event-discovery`` Supabase Edge Function with one of four actions:
``plan``, ``search``, ``crawl`` or ``status``. Planning, search and crawl work
is always bounded by ``--max-batches`` and resumes from durable server-side
queues.

``GLOBAL_SCRAPER_SECRET`` is read from the environment and is never accepted
as a command-line argument or written to the state file / JSON output.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


FUNCTION_NAME = "global-event-discovery"
DEFAULT_LOOKAHEAD_DAYS = 1
USER_AGENT = (
    "EVENTA-Global-Event-Discovery-Runner/1.0 "
    "(+https://github.com/mtnrconcept/event-horizon-finder)"
)
DEFAULT_STATE_FILE = Path(".cache/global-event-discovery/state.json")
TRANSIENT_HTTP_CODES = frozenset({408, 425, 429, 500, 502, 503, 504})
SENSITIVE_KEY_PARTS = (
    "authorization",
    "password",
    "secret",
    "service_role",
    "access_token",
    "api_key",
    "apikey",
)
CAMPAIGN_ID_KEYS = ("campaign_id", "campaignId")


class RunnerError(RuntimeError):
    """A user-facing failure whose message has already been made safe."""


def normalize_supabase_function_url(value: str) -> str:
    """Return the canonical Edge Function URL for a project URL or ref.

    Production URLs must use HTTPS. HTTP remains available for a local
    Supabase stack only, so development does not require a TLS proxy.
    Existing ``/functions/v1/...`` paths are deliberately replaced to avoid
    accidentally invoking a different function.
    """

    raw = (value or "").strip().rstrip("/")
    if not raw:
        raise RunnerError("SUPABASE_URL is required")

    if re.fullmatch(r"[a-z0-9][a-z0-9-]{3,62}", raw, re.IGNORECASE):
        raw = f"https://{raw.lower()}.supabase.co"
    elif "://" not in raw:
        raise RunnerError("SUPABASE_URL must be an HTTPS URL or a Supabase project ref")

    parsed = urlsplit(raw)
    hostname = (parsed.hostname or "").casefold()
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme not in {"http", "https"} or not hostname:
        raise RunnerError("SUPABASE_URL must be an absolute HTTP(S) URL")
    if parsed.scheme != "https" and hostname not in local_hosts:
        raise RunnerError("SUPABASE_URL must use HTTPS outside local development")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RunnerError("SUPABASE_URL must not contain credentials, a query or a fragment")

    endpoint_path = f"/functions/v1/{FUNCTION_NAME}"
    return urlunsplit((parsed.scheme, parsed.netloc, endpoint_path, "", ""))


def sanitize_for_output(value: Any, secret: str = "") -> Any:
    """Recursively redact credentials and the configured scraper secret."""

    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for key, child in value.items():
            text_key = str(key)
            lowered = text_key.casefold()
            if any(part in lowered for part in SENSITIVE_KEY_PARTS):
                output[text_key] = "[redacted]"
            else:
                output[text_key] = sanitize_for_output(child, secret)
        return output
    if isinstance(value, (list, tuple)):
        return [sanitize_for_output(child, secret) for child in value]
    if isinstance(value, str) and secret and secret in value:
        return value.replace(secret, "[redacted]")
    return value


def _safe_error(error: BaseException, secret: str) -> str:
    text = str(error).replace("\r", " ").replace("\n", " ")[:1_200]
    if secret:
        text = text.replace(secret, "[redacted]")
    return text


def _json_line(value: Mapping[str, Any], secret: str = "") -> None:
    print(
        json.dumps(
            sanitize_for_output(value, secret),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        flush=True,
    )


def _mapping_children(value: Any, depth: int = 0) -> list[Mapping[str, Any]]:
    if depth > 4:
        return []
    if isinstance(value, Mapping):
        output = [value]
        for child in value.values():
            if isinstance(child, (Mapping, list, tuple)):
                output.extend(_mapping_children(child, depth + 1))
        return output
    if isinstance(value, (list, tuple)):
        output: list[Mapping[str, Any]] = []
        for child in value:
            output.extend(_mapping_children(child, depth + 1))
        return output
    return []


def extract_campaign_id(value: Any) -> str | None:
    """Accept common snake/camel response envelopes without guessing job IDs."""

    mappings = _mapping_children(value)
    for mapping in mappings:
        for key in CAMPAIGN_ID_KEYS:
            candidate = mapping.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()[:200]

    if isinstance(value, Mapping):
        campaign = value.get("campaign")
        if isinstance(campaign, Mapping):
            candidate = campaign.get("id")
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()[:200]
    return None


def _key_forms(key: Any) -> set[str]:
    raw = str(key).strip().casefold()
    compact = re.sub(r"[^a-z0-9]", "", raw)
    return {raw, compact}


def _find_value(value: Any, keys: set[str]) -> Any:
    normalized_keys = keys | {re.sub(r"[^a-z0-9]", "", key.casefold()) for key in keys}
    for mapping in _mapping_children(value):
        for key, child in mapping.items():
            if _key_forms(key) & normalized_keys:
                return child
    return None


def _nonnegative_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    if isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        return float(value)
    return None


def infer_stop_reason(response: Any, action: str) -> str | None:
    """Infer queue exhaustion from several compatible response shapes.

    Unknown responses deliberately run until the configured batch ceiling;
    the client never converts an unfamiliar response into an unbounded loop.
    """

    done = _find_value(response, {"done", "queue_done", f"{action}_done"})
    if done is True:
        return "done"

    has_more = _find_value(response, {"has_more", "hasMore", f"{action}_has_more"})
    if has_more is False:
        return "no_more_work"

    remaining_keys = {
        "remaining",
        "remaining_jobs",
        "queued",
        "pending",
        "pending_jobs",
        f"{action}_remaining",
        f"{action}_queued",
        f"{action}_pending",
    }
    remaining = _nonnegative_number(_find_value(response, remaining_keys))
    if remaining == 0:
        return "queue_empty"

    claimed_keys = {"claimed", "leased", "processed", f"{action}_claimed"}
    claimed = _nonnegative_number(_find_value(response, claimed_keys))
    if claimed == 0:
        return "idle"
    return None


def require_success_response(response: Any, action: str) -> None:
    """Reject a logical worker failure even when the HTTP request succeeded."""

    if not isinstance(response, Mapping) or response.get("ok") is not False:
        return
    failed = _nonnegative_number(_find_value(response, {"failed", f"{action}_failed"}))
    error = _find_value(response, {"error", "error_code", "code"})
    suffix = f":{str(error)[:200]}" if isinstance(error, str) and error.strip() else ""
    count = int(failed) if failed is not None else "unknown"
    raise RunnerError(f"{action}_worker_reported_failure:{count}{suffix}")


class DiscoveryClient:
    def __init__(
        self,
        function_url: str,
        secret: str,
        *,
        timeout: int = 90,
        retries: int = 2,
    ) -> None:
        if len(secret.strip()) < 32:
            raise RunnerError("GLOBAL_SCRAPER_SECRET must contain at least 32 characters")
        self.function_url = function_url
        self.secret = secret.strip()
        self.timeout = timeout
        self.retries = retries

    def call(self, action: str, payload: Mapping[str, Any] | None = None) -> Any:
        body = {"action": action}
        if payload:
            body.update(payload)
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.secret}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "x-global-scraper-secret": self.secret,
        }

        last_error: BaseException | None = None
        for attempt in range(self.retries + 1):
            request = Request(self.function_url, data=encoded, method="POST", headers=headers)
            try:
                with urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                    raw = response.read().decode("utf-8", errors="replace")
                    if not raw.strip():
                        return {}
                    try:
                        return json.loads(raw)
                    except json.JSONDecodeError as error:
                        raise RunnerError("Edge Function returned invalid JSON") from error
            except HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:1_000]
                last_error = RunnerError(
                    f"Edge Function HTTP {error.code}: {detail or error.reason}"
                )
                if error.code not in TRANSIENT_HTTP_CODES:
                    break
            except (URLError, TimeoutError, OSError) as error:
                last_error = error

            if attempt < self.retries:
                time.sleep(min(2**attempt, 8))

        raise RunnerError(_safe_error(last_error or RuntimeError("request failed"), self.secret))


@dataclass
class StateStore:
    path: Path | None

    def load_campaign_id(self) -> str | None:
        if self.path is None or not self.path.exists():
            return None
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RunnerError(f"Unable to read state file: {error}") from error
        candidate = raw.get("campaign_id") if isinstance(raw, Mapping) else None
        return candidate.strip()[:200] if isinstance(candidate, str) and candidate.strip() else None

    def save(self, campaign_id: str, *, action: str, target_date: str | None = None) -> None:
        if self.path is None:
            return
        payload = {
            "campaign_id": campaign_id,
            "last_action": action,
            "target_date": target_date,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
            temporary.replace(self.path)
        except OSError as error:
            raise RunnerError(f"Unable to write state file: {error}") from error


@dataclass(frozen=True)
class LoopResult:
    calls: int
    campaign_id: str
    stop_reason: str


def run_worker_loop(
    client: DiscoveryClient,
    state: StateStore,
    *,
    action: str,
    campaign_id: str,
    batch_size: int,
    max_batches: int,
    pause_seconds: float,
) -> LoopResult:
    stop_reason = "batch_limit"
    current_campaign = campaign_id
    calls = 0

    for iteration in range(1, max_batches + 1):
        response = client.call(
            action,
            {"campaign_id": current_campaign, "batch_size": batch_size},
        )
        require_success_response(response, action)
        calls = iteration
        current_campaign = extract_campaign_id(response) or current_campaign
        state.save(current_campaign, action=action)
        reason = infer_stop_reason(response, action)
        _json_line(
            {
                "ok": True,
                "action": action,
                "iteration": iteration,
                "campaign_id": current_campaign,
                "response": response,
                "stop_reason": reason,
            },
            client.secret,
        )
        if reason:
            stop_reason = reason
            break
        if iteration < max_batches and pause_seconds:
            time.sleep(pause_seconds)

    return LoopResult(calls=calls, campaign_id=current_campaign, stop_reason=stop_reason)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 500:
        raise argparse.ArgumentTypeError("must be between 1 and 500")
    return parsed


def _batch_size(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 50:
        raise argparse.ArgumentTypeError("must be between 1 and 50")
    return parsed


def _pause(value: str) -> float:
    parsed = float(value)
    if not 0 <= parsed <= 300:
        raise argparse.ArgumentTypeError("must be between 0 and 300 seconds")
    return parsed


def _iso_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise argparse.ArgumentTypeError("must use YYYY-MM-DD") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "search", "crawl", "status"))
    parser.add_argument(
        "--supabase-url",
        help="Project URL/ref; defaults to SUPABASE_URL or SUPABASE_PROJECT_ID",
    )
    parser.add_argument("--campaign-id", help="Override the campaign stored in --state-file")
    parser.add_argument(
        "--state-file",
        type=Path,
        default=DEFAULT_STATE_FILE,
        help="Non-secret campaign resume state",
    )
    parser.add_argument("--no-state", action="store_true", help="Do not read or write resume state")
    parser.add_argument("--target-date", type=_iso_date, help="Planning date (YYYY-MM-DD)")
    parser.add_argument("--batch-size", type=_batch_size, help="Jobs claimed by each worker call")
    parser.add_argument("--max-batches", type=_positive_int, default=10)
    parser.add_argument("--pause-seconds", type=_pause, default=2.0)
    parser.add_argument("--timeout", type=_positive_int, default=90)
    parser.add_argument("--retries", type=int, choices=range(0, 6), default=2)
    return parser


def _campaign_or_error(explicit: str | None, state: StateStore) -> str:
    campaign_id = (explicit or "").strip() or state.load_campaign_id()
    if not campaign_id:
        raise RunnerError("--campaign-id is required until a plan has populated --state-file")
    if any(ord(character) < 32 for character in campaign_id) or len(campaign_id) > 200:
        raise RunnerError("Invalid campaign id")
    return campaign_id


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    secret = os.environ.get("GLOBAL_SCRAPER_SECRET", "").strip()
    project_value = (
        args.supabase_url
        or os.environ.get("SUPABASE_URL", "").strip()
        or os.environ.get("SUPABASE_PROJECT_ID", "").strip()
    )

    try:
        function_url = normalize_supabase_function_url(project_value)
        client = DiscoveryClient(
            function_url,
            secret,
            timeout=args.timeout,
            retries=args.retries,
        )
        state = StateStore(None if args.no_state else args.state_file)

        if args.action == "plan":
            target_date = args.target_date or (
                date.today() + timedelta(days=DEFAULT_LOOKAHEAD_DAYS)
            ).isoformat()
            payload: dict[str, Any] = {
                "target_date": target_date,
                "batch_size": args.batch_size or 25,
            }
            campaign_id: str | None = None
            calls = 0
            stop_reason = "batch_limit"
            for iteration in range(1, args.max_batches + 1):
                response = client.call("plan", payload)
                require_success_response(response, "plan")
                calls = iteration
                campaign_id = extract_campaign_id(response) or campaign_id
                if campaign_id:
                    state.save(campaign_id, action="plan", target_date=target_date)
                reason = infer_stop_reason(response, "plan")
                _json_line(
                    {
                        "ok": True,
                        "action": "plan",
                        "iteration": iteration,
                        "campaign_id": campaign_id,
                        "response": response,
                        "stop_reason": reason,
                    },
                    client.secret,
                )
                if reason:
                    stop_reason = reason
                    break
                if iteration < args.max_batches and args.pause_seconds:
                    time.sleep(args.pause_seconds)
            _json_line(
                {
                    "ok": True,
                    "action": "plan",
                    "summary": {
                        "calls": calls,
                        "campaign_id": campaign_id,
                        "stop_reason": stop_reason,
                    },
                },
                client.secret,
            )
            return 0

        campaign_id = _campaign_or_error(args.campaign_id, state)
        if args.action == "status":
            response = client.call("status", {"campaign_id": campaign_id})
            require_success_response(response, "status")
            current_campaign = extract_campaign_id(response) or campaign_id
            state.save(current_campaign, action="status")
            _json_line(
                {
                    "ok": True,
                    "action": "status",
                    "campaign_id": current_campaign,
                    "response": response,
                },
                client.secret,
            )
            return 0

        batch_size = args.batch_size or (5 if args.action == "search" else 2)
        result = run_worker_loop(
            client,
            state,
            action=args.action,
            campaign_id=campaign_id,
            batch_size=batch_size,
            max_batches=args.max_batches,
            pause_seconds=args.pause_seconds,
        )
        _json_line(
            {
                "ok": True,
                "action": args.action,
                "summary": {
                    "calls": result.calls,
                    "campaign_id": result.campaign_id,
                    "stop_reason": result.stop_reason,
                },
            },
            client.secret,
        )
        return 0
    except (RunnerError, ValueError, OSError) as error:
        safe_message = _safe_error(error, secret)
        print(
            json.dumps(
                {"ok": False, "action": args.action, "error": safe_message},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
