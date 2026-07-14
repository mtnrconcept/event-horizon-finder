#!/usr/bin/env python3
"""Collect Geneva nightlife and music events for EVENTA.

Production mode orchestrates the protected Supabase Edge Function in resilient
batches. Direct mode can inspect official pages locally, extract schema.org
Event JSON-LD, optionally fall back to Firecrawl, and write through EVENTA's
service-role-only ``upsert_ingested_event`` RPC.

Secrets are read exclusively from environment variables; never pass them on
the command line or commit them to the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Iterable, Iterator, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen


USER_AGENT = "EVENTA-Geneva-Event-Collector/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)"
# A server batch may perform two 72-second Firecrawl attempts plus backoff.
# The client must wait longer or it will retry a still-running batch.
DEFAULT_TIMEOUT = 210
MAX_BATCH_SIZE = 4
MAX_DIRECT_LINKS = 40
EVENT_PATH_HINT = re.compile(
    r"(?:agenda|event|evenement|programme|concert|festival|soiree|party|club)", re.IGNORECASE
)
SKIP_PATH = re.compile(
    r"\.(?:avif|css|gif|ico|jpe?g|js|pdf|png|svg|webp|xml|zip)(?:$|\?)", re.IGNORECASE
)


class CollectorError(RuntimeError):
    """A safe, user-facing collector failure."""


@dataclass(frozen=True)
class Source:
    id: str | None
    name: str
    base_url: str
    category: str = "concerts"
    page_count: int = 1
    metadata: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class Event:
    title: str
    starts_at: str
    source_url: str
    description: str | None = None
    ends_at: str | None = None
    venue_name: str | None = None
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    category: str | None = None
    ticket_url: str | None = None
    image_url: str | None = None
    is_free: bool = False
    external_identifier: str | None = None

    def rpc_payload(self, source_id: str) -> dict[str, Any]:
        return {
            "_data_source_id": source_id,
            "_source_url": self.source_url,
            "_title": self.title,
            "_description": self.description,
            "_starts_at": self.starts_at,
            "_ends_at": self.ends_at,
            "_venue_name": self.venue_name,
            "_address": self.address,
            "_latitude": self.latitude,
            "_longitude": self.longitude,
            "_category": self.category,
            "_ticket_url": self.ticket_url,
            "_image_url": self.image_url,
            "_is_free": self.is_free,
            "_external_identifier": self.external_identifier,
        }


class AgendaHTMLParser(HTMLParser):
    """Collect JSON-LD blocks and same-page links without external packages."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.json_ld: list[str] = []
        self.links: list[str] = []
        self._in_json_ld = False
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value for name, value in attrs}
        if tag.lower() == "script" and (values.get("type") or "").lower() == "application/ld+json":
            self._in_json_ld = True
            self._script_parts = []
        elif tag.lower() == "a" and values.get("href"):
            self.links.append(values["href"] or "")

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self._script_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._in_json_ld:
            block = "".join(self._script_parts).strip()
            if block:
                self.json_ld.append(block)
            self._in_json_ld = False
            self._script_parts = []


def _request_json(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    payload: Mapping[str, Any] | Sequence[Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    retries: int = 2,
) -> Any:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = Request(url, data=body, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 - URLs are allow-listed.
                raw = response.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw else {}
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:800]
            last_error = CollectorError(f"HTTP {error.code} for {url}: {detail or error.reason}")
            if error.code not in (408, 425, 429) and error.code < 500:
                break
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
        if attempt < retries:
            time.sleep(min(2**attempt, 5))
    raise CollectorError(str(last_error or f"Request failed: {url}"))


def _request_text(url: str, *, timeout: int = DEFAULT_TIMEOUT, retries: int = 2) -> str:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = Request(url, headers={"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT})
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 - URLs are allow-listed.
                content_type = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(content_type, errors="replace")
        except HTTPError as error:
            last_error = CollectorError(f"HTTP {error.code} for {url}: {error.reason}")
            if error.code not in (408, 425, 429) and error.code < 500:
                break
        except (URLError, TimeoutError) as error:
            last_error = error
        if attempt < retries:
            time.sleep(min(2**attempt, 5))
    raise CollectorError(str(last_error or f"Request failed: {url}"))


def _iter_json_objects(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        yield value
        for child in value.values():
            yield from _iter_json_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_json_objects(child)


def _has_event_type(value: Any) -> bool:
    types = value if isinstance(value, list) else [value]
    return any(str(item).lower().endswith("event") for item in types)


def _first_text(value: Any) -> str | None:
    if isinstance(value, str):
        clean = re.sub(r"\s+", " ", value).strip()
        return clean or None
    if isinstance(value, list):
        for item in value:
            found = _first_text(item)
            if found:
                return found
    if isinstance(value, Mapping):
        return _first_text(value.get("url") or value.get("contentUrl"))
    return None


def _absolute_http_url(value: Any, base_url: str) -> str | None:
    text = _first_text(value)
    if not text:
        return None
    candidate = urljoin(base_url, text)
    parsed = urlparse(candidate)
    return candidate if parsed.scheme in ("http", "https") and parsed.netloc else None


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None


def _iso_datetime(value: Any) -> str | None:
    text = _first_text(value)
    if not text:
        return None
    candidate = text.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Official Geneva pages without an offset are interpreted in local time.
        try:
            from zoneinfo import ZoneInfo

            parsed = parsed.replace(tzinfo=ZoneInfo("Europe/Zurich"))
        except Exception:  # pragma: no cover - zoneinfo is part of supported Python versions.
            parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _event_from_json_ld(raw: Mapping[str, Any], page_url: str, category: str) -> Event | None:
    if not _has_event_type(raw.get("@type")):
        return None
    title = _first_text(raw.get("name") or raw.get("headline"))
    starts_at = _iso_datetime(raw.get("startDate"))
    if not title or not starts_at:
        return None

    location = raw.get("location") if isinstance(raw.get("location"), Mapping) else {}
    address_value = location.get("address") if isinstance(location, Mapping) else None
    if isinstance(address_value, Mapping):
        address = ", ".join(
            filter(
                None,
                (
                    _first_text(address_value.get("streetAddress")),
                    _first_text(address_value.get("postalCode")),
                    _first_text(address_value.get("addressLocality")),
                ),
            )
        ) or None
    else:
        address = _first_text(address_value)
    geo = location.get("geo") if isinstance(location, Mapping) and isinstance(location.get("geo"), Mapping) else {}

    offers_value = raw.get("offers")
    offers = offers_value[0] if isinstance(offers_value, list) and offers_value else offers_value
    offers = offers if isinstance(offers, Mapping) else {}
    price = _number(offers.get("price"))
    source_url = _absolute_http_url(raw.get("url") or raw.get("@id"), page_url) or page_url
    ticket_url = _absolute_http_url(offers.get("url"), source_url)

    return Event(
        title=title[:240],
        starts_at=starts_at,
        ends_at=_iso_datetime(raw.get("endDate")),
        source_url=source_url,
        description=_first_text(raw.get("description")),
        venue_name=_first_text(location.get("name")) if isinstance(location, Mapping) else None,
        address=address,
        latitude=_number(geo.get("latitude")) if isinstance(geo, Mapping) else None,
        longitude=_number(geo.get("longitude")) if isinstance(geo, Mapping) else None,
        category=_first_text(raw.get("eventType")) or category,
        ticket_url=ticket_url,
        image_url=_absolute_http_url(raw.get("image"), source_url),
        is_free=price == 0 if price is not None else False,
        external_identifier=_first_text(raw.get("identifier") or raw.get("@id")),
    )


def extract_json_ld_events(html: str, page_url: str, category: str = "concerts") -> list[Event]:
    parser = AgendaHTMLParser()
    parser.feed(html)
    events: list[Event] = []
    seen: set[tuple[str, str, str]] = set()
    for block in parser.json_ld:
        try:
            document = json.loads(block)
        except json.JSONDecodeError:
            continue
        for raw in _iter_json_objects(document):
            event = _event_from_json_ld(raw, page_url, category)
            if not event:
                continue
            key = (event.title.casefold(), event.starts_at, event.source_url)
            if key not in seen:
                seen.add(key)
                events.append(event)
    return events


def discover_event_links(html: str, page_url: str, limit: int = MAX_DIRECT_LINKS) -> list[str]:
    parser = AgendaHTMLParser()
    parser.feed(html)
    base_host = urlparse(page_url).netloc.lower().removeprefix("www.")
    result: list[str] = []
    seen: set[str] = set()
    for href in parser.links:
        candidate = urljoin(page_url, href).split("#", 1)[0]
        parsed = urlparse(candidate)
        host = parsed.netloc.lower().removeprefix("www.")
        if parsed.scheme not in ("http", "https") or host != base_host:
            continue
        if candidate in seen or SKIP_PATH.search(candidate) or not EVENT_PATH_HINT.search(parsed.path):
            continue
        seen.add(candidate)
        result.append(candidate)
        if len(result) >= limit:
            break
    return result


def _future_event(event: Event) -> bool:
    try:
        start = datetime.fromisoformat(event.starts_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    now = datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return now - timedelta(days=2) <= start.astimezone(timezone.utc) <= now + timedelta(days=730)


def _source_page_url(source: Source, page: int) -> str:
    if page == 0:
        return source.base_url
    if (source.metadata or {}).get("pagination") == "page":
        separator = "&" if "?" in source.base_url else "?"
        return f"{source.base_url}{separator}page={page}"
    return source.base_url


def _firecrawl_events(source: Source, page_url: str, api_key: str, timeout: int) -> list[Event]:
    schema = {
        "type": "object",
        "properties": {
            "events": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "externalId": {"type": ["string", "null"]},
                        "title": {"type": "string"},
                        "description": {"type": ["string", "null"]},
                        "startDate": {"type": ["string", "null"]},
                        "endDate": {"type": ["string", "null"]},
                        "venueName": {"type": ["string", "null"]},
                        "address": {"type": ["string", "null"]},
                        "latitude": {"type": ["number", "null"]},
                        "longitude": {"type": ["number", "null"]},
                        "category": {"type": ["string", "null"]},
                        "ticketUrl": {"type": ["string", "null"]},
                        "imageUrl": {"type": ["string", "null"]},
                        "isFree": {"type": ["boolean", "null"]},
                        "sourceUrl": {"type": ["string", "null"]},
                    },
                    "required": ["title", "startDate"],
                },
            }
        },
        "required": ["events"],
    }
    response = _request_json(
        "https://api.firecrawl.dev/v2/scrape",
        method="POST",
        headers={"Authorization": f"Bearer {api_key}"},
        payload={
            "url": page_url,
            "onlyMainContent": True,
            "maxAge": 3_600_000,
            "formats": [
                {
                    "type": "json",
                    "schema": schema,
                    "prompt": (
                        "Extrais tous les événements futurs réels visibles: clubs, soirées, festivals et concerts. "
                        "Une ligne par occurrence, dates ISO 8601 Europe/Zurich, lien officiel dans sourceUrl, "
                        "aucune invention et aucun élément de navigation."
                    ),
                }
            ],
        },
        timeout=timeout,
    )
    raw_events = ((response or {}).get("data") or {}).get("json", {}).get("events", [])
    events: list[Event] = []
    for raw in raw_events if isinstance(raw_events, list) else []:
        if not isinstance(raw, Mapping):
            continue
        title = _first_text(raw.get("title"))
        starts_at = _iso_datetime(raw.get("startDate"))
        if not title or not starts_at:
            continue
        source_url = _absolute_http_url(raw.get("sourceUrl"), page_url) or page_url
        event = Event(
            title=title[:240],
            starts_at=starts_at,
            ends_at=_iso_datetime(raw.get("endDate")),
            source_url=source_url,
            description=_first_text(raw.get("description")),
            venue_name=_first_text(raw.get("venueName")),
            address=_first_text(raw.get("address")),
            latitude=_number(raw.get("latitude")),
            longitude=_number(raw.get("longitude")),
            category=_first_text(raw.get("category")) or source.category,
            ticket_url=_absolute_http_url(raw.get("ticketUrl"), source_url),
            image_url=_absolute_http_url(raw.get("imageUrl"), source_url),
            is_free=raw.get("isFree") is True,
            external_identifier=_first_text(raw.get("externalId")),
        )
        if _future_event(event):
            events.append(event)
    return events


class SupabaseREST:
    def __init__(self, url: str, service_key: str, timeout: int) -> None:
        self.url = url.rstrip("/")
        self.headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self.timeout = timeout

    def sources(self, source_ids: Sequence[str]) -> list[Source]:
        city_rows = _request_json(
            f"{self.url}/rest/v1/cities?slug=eq.geneve&select=id&limit=1",
            headers=self.headers,
            timeout=self.timeout,
        )
        if not city_rows:
            raise CollectorError("The Geneva city row is missing in Supabase")
        query = {
            "select": "id,name,base_url,category_slug,page_count,metadata",
            "status": "eq.active",
            "is_authorized": "eq.true",
            "is_verified": "eq.true",
            "city_id": f"eq.{city_rows[0]['id']}",
            "order": "priority.asc,name.asc",
        }
        if source_ids:
            query["id"] = f"in.({','.join(source_ids)})"
        rows = _request_json(
            f"{self.url}/rest/v1/data_sources?{urlencode(query)}",
            headers=self.headers,
            timeout=self.timeout,
        )
        return [
            Source(
                id=row["id"],
                name=row["name"],
                base_url=row["base_url"],
                category=row.get("category_slug") or "concerts",
                page_count=max(1, min(int(row.get("page_count") or 1), 40)),
                metadata=row.get("metadata") or {},
            )
            for row in rows
        ]

    def upsert(self, source_id: str, event: Event) -> Mapping[str, Any]:
        result = _request_json(
            f"{self.url}/rest/v1/rpc/upsert_ingested_event",
            method="POST",
            headers=self.headers,
            payload=event.rpc_payload(source_id),
            timeout=self.timeout,
        )
        if isinstance(result, list):
            return result[0] if result else {}
        return result if isinstance(result, Mapping) else {}


def _dedupe(events: Iterable[Event]) -> list[Event]:
    result: list[Event] = []
    seen: set[tuple[str, str, str]] = set()
    for event in events:
        key = (event.title.casefold(), event.starts_at, urlparse(event.source_url).path.rstrip("/"))
        if key not in seen and _future_event(event):
            seen.add(key)
            result.append(event)
    return result


def run_edge(args: argparse.Namespace) -> int:
    # CI exposes a normalized URL because an old or malformed SUPABASE_URL
    # secret must not turn into an invalid DNS hostname.
    supabase_url = (
        os.getenv("SUPABASE_FUNCTION_URL") or os.getenv("SUPABASE_URL") or ""
    ).strip().rstrip("/")
    secret = (os.getenv("GENEVA_SCRAPER_SECRET") or "").strip()
    if not supabase_url or not secret:
        raise CollectorError("SUPABASE_URL and GENEVA_SCRAPER_SECRET are required in edge mode")

    cursor = 0
    started_at = datetime.now(timezone.utc).isoformat()
    totals = {"created": 0, "updated": 0, "rejected": 0, "success": 0, "failed": 0}
    for iteration in range(1, args.max_batches + 1):
        payload: dict[str, Any] = {
            "cursor": cursor,
            "batchSize": args.batch_size,
            "runStartedAt": started_at,
            "force": args.force,
        }
        if args.source_id:
            payload["sourceIds"] = args.source_id
        response = _request_json(
            f"{supabase_url}/functions/v1/scrape-geneva-events",
            method="POST",
            headers={"x-geneva-scraper-secret": secret},
            payload=payload,
            timeout=args.timeout,
        )
        if not isinstance(response, Mapping):
            raise CollectorError("Unexpected response from scrape-geneva-events")
        batch = {
            "batch": iteration,
            "cursor": response.get("cursor"),
            "next_cursor": response.get("nextCursor"),
            "has_more": bool(response.get("hasMore")),
            "pages_success": int(response.get("pagesSuccess") or 0),
            "pages_failed": int(response.get("pagesFailed") or 0),
            "events_created": int(response.get("eventsCreated") or 0),
            "events_updated": int(response.get("eventsUpdated") or 0),
            "events_rejected": int(response.get("eventsRejected") or 0),
        }
        print(json.dumps(batch, ensure_ascii=False))
        totals["created"] += batch["events_created"]
        totals["updated"] += batch["events_updated"]
        totals["rejected"] += batch["events_rejected"]
        totals["success"] += batch["pages_success"]
        totals["failed"] += batch["pages_failed"]
        next_cursor = response.get("nextCursor")
        if not response.get("hasMore"):
            print(json.dumps({"completed": True, **totals}, ensure_ascii=False))
            return 1 if totals["success"] == 0 and totals["failed"] > 0 else 0
        if not isinstance(next_cursor, int) or next_cursor <= cursor:
            raise CollectorError("The scraper cursor did not advance")
        cursor = next_cursor
    print(json.dumps({"completed": False, "continuation_required": True, **totals}, ensure_ascii=False))
    return 0


def _direct_source_events(source: Source, args: argparse.Namespace) -> tuple[list[Event], list[str]]:
    events: list[Event] = []
    errors: list[str] = []
    firecrawl_key = (os.getenv("FIRECRAWL_API_KEY") or "").strip()
    for page in range(source.page_count):
        page_url = _source_page_url(source, page)
        try:
            html = _request_text(page_url, timeout=args.timeout)
            page_events = extract_json_ld_events(html, page_url, source.category)
            if args.follow_links and len(page_events) < 2:
                for detail_url in discover_event_links(html, page_url, args.follow_links):
                    try:
                        detail_html = _request_text(detail_url, timeout=args.timeout, retries=1)
                        page_events.extend(extract_json_ld_events(detail_html, detail_url, source.category))
                    except CollectorError as error:
                        errors.append(f"{detail_url}: {error}")
            if not page_events and firecrawl_key:
                page_events = _firecrawl_events(source, page_url, firecrawl_key, args.timeout)
            events.extend(page_events)
        except CollectorError as error:
            errors.append(f"{page_url}: {error}")
    return _dedupe(events), errors


def run_direct(args: argparse.Namespace) -> int:
    service_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    database = SupabaseREST(supabase_url, service_key, args.timeout) if supabase_url and service_key else None
    if args.url:
        sources = [Source(None, args.venue or urlparse(args.url).netloc, args.url, args.category)]
    else:
        if not database:
            raise CollectorError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to load the source registry; "
                "alternatively pass --url for a local dry run"
            )
        sources = database.sources(args.source_id)
    if args.write and not database:
        raise CollectorError("--write requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")

    summary = {"sources": len(sources), "extracted": 0, "created": 0, "updated": 0, "errors": 0}
    for source in sources:
        events, errors = _direct_source_events(source, args)
        summary["extracted"] += len(events)
        summary["errors"] += len(errors)
        for error in errors[:5]:
            print(json.dumps({"source": source.name, "warning": error}, ensure_ascii=False), file=sys.stderr)
        for event in events:
            if args.write:
                if not source.id:
                    raise CollectorError("A registered data source is required when using --write")
                outcome = database.upsert(source.id, event) if database else {}
                action = str(outcome.get("action") or "updated")
                summary["created" if action == "created" else "updated"] += 1
            else:
                print(json.dumps(event.__dict__, ensure_ascii=False, sort_keys=True))
        print(json.dumps({"source": source.name, "events": len(events), "warnings": len(errors)}, ensure_ascii=False))
    print(json.dumps({"completed": True, **summary}, ensure_ascii=False))
    return 0 if summary["extracted"] > 0 or not sources else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Continuously scrape allow-listed club, festival and concert sources worldwide"
    )
    parser.add_argument("--mode", choices=("edge", "direct"), default="edge")
    parser.add_argument("--source-id", action="append", default=[], help="Restrict to one source UUID; repeatable")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--force", action="store_true", help="Ignore the per-source synchronization schedule")
    parser.add_argument("--batch-size", type=int, default=3, choices=range(1, MAX_BATCH_SIZE + 1))
    parser.add_argument("--max-batches", type=int, default=100)
    parser.add_argument("--url", help="Direct-mode URL for an unregistered local dry run")
    parser.add_argument("--venue", help="Venue name used with --url")
    parser.add_argument("--category", default="concerts", choices=("soirees", "festivals", "concerts"))
    parser.add_argument(
        "--follow-links",
        type=int,
        default=0,
        choices=range(0, MAX_DIRECT_LINKS + 1),
        metavar="N",
        help="Direct mode: inspect up to N same-domain event detail links per page",
    )
    parser.add_argument("--write", action="store_true", help="Direct mode: persist through the protected RPC")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout < 5 or args.timeout > 300:
        raise CollectorError("--timeout must be between 5 and 300 seconds")
    if args.max_batches < 1 or args.max_batches > 500:
        raise CollectorError("--max-batches must be between 1 and 500")
    return run_edge(args) if args.mode == "edge" else run_direct(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectorError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
