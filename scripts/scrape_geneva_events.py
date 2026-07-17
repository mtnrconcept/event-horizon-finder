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
import math
import os
import re
import sys
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from html import unescape
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
SUPPORTED_CATEGORIES = (
    "concerts",
    "festivals",
    "expositions",
    "soirees",
    "theatre",
    "famille",
    "sports-outdoor",
    "heritage",
    "gastronomy",
    "activities",
    "conferences",
    "cinema",
    "leisure",
    "other",
)
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
    category: str | None = None
    page_count: int = 1
    metadata: Mapping[str, Any] | None = None
    city: str = "Genève"
    timezone: str = "Europe/Zurich"
    latitude: float | None = 46.2044
    longitude: float | None = 6.1432
    country_code: str = "CH"


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
    timezone: str = "Europe/Zurich"
    time_precision: str = "exact"
    all_day: bool = False
    city: str | None = None
    region: str | None = None
    country_code: str | None = None
    organizer_name: str | None = None
    organizer_url: str | None = None
    status: str = "scheduled"
    language: str | None = None
    genres: tuple[str, ...] = ()
    capacity: int | None = None
    price_min: float | None = None
    price_max: float | None = None
    currency: str | None = None
    quality_score: int = 0
    warnings: tuple[str, ...] = ()

    def rpc_payload(self, source_id: str) -> dict[str, Any]:
        return {
            "_data_source_id": source_id,
            "_payload": {
                "source_url": self.source_url,
                "title": self.title,
                "description": self.description,
                "starts_at": self.starts_at,
                "ends_at": self.ends_at,
                "venue_name": self.venue_name,
                "address": self.address,
                "latitude": self.latitude,
                "longitude": self.longitude,
                "category": self.category,
                "ticket_url": self.ticket_url,
                "image_url": self.image_url,
                "is_free": self.is_free,
                "external_identifier": self.external_identifier,
                "timezone": self.timezone,
                "time_precision": self.time_precision,
                "all_day": self.all_day,
                "city": self.city,
                "region": self.region,
                "country_code": self.country_code,
                "organizer_name": self.organizer_name,
                "organizer_url": self.organizer_url,
                "status": self.status,
                "language": self.language,
                "genres": list(self.genres),
                "capacity": self.capacity,
                "price_min": self.price_min,
                "price_max": self.price_max,
                "currency": self.currency,
                "ticket_status": "free" if self.is_free else "available" if self.ticket_url else "unknown",
                "quality_score": self.quality_score,
                "warnings": list(self.warnings),
            },
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
        return _first_text(
            value.get("name")
            or value.get("value")
            or value.get("url")
            or value.get("contentUrl")
            or value.get("@id")
        )
    return None


def _absolute_http_url(value: Any, base_url: str) -> str | None:
    text = _first_text(value)
    if not text:
        return None
    candidate = urljoin(base_url, text)
    parsed = urlparse(candidate)
    return candidate if parsed.scheme in ("http", "https") and parsed.netloc else None


def _number(value: Any) -> float | None:
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:[.,]\d+)?", value.replace("'", ""))
        value = match.group(0).replace(",", ".") if match else value
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None


def _currency_for_country(country_code: str | None) -> str | None:
    if not country_code:
        return None
    return {
        "CH": "CHF", "GB": "GBP", "US": "USD", "CA": "CAD", "AU": "AUD",
        "NZ": "NZD", "JP": "JPY", "PL": "PLN", "CZ": "CZK", "HU": "HUF",
        "SE": "SEK", "NO": "NOK", "DK": "DKK", "MX": "MXN", "KR": "KRW",
        "SG": "SGD", "AE": "AED", "ZA": "ZAR", "MA": "MAD",
    }.get(country_code.upper())


def _iso_datetime(value: Any, timezone_name: str = "Europe/Zurich") -> str | None:
    text = _first_text(value)
    if not text:
        return None
    candidate = text.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # A source-local time must never be interpreted in the CI runner timezone.
        try:
            from zoneinfo import ZoneInfo

            parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
        except Exception:  # pragma: no cover - zoneinfo is part of supported Python versions.
            parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _canonical_http_url(value: Any, base_url: str) -> str | None:
    candidate = _absolute_http_url(value, base_url)
    if not candidate:
        return None
    parsed = urlparse(candidate)
    query = [
        part
        for part in parsed.query.split("&")
        if part and not re.match(r"(?i)(?:utm_[^=]*|fbclid|gclid|ref|source)=", part)
    ]
    return parsed._replace(query="&".join(query), fragment="").geturl()


def _source_host_matches(candidate_url: str, source_url: str) -> bool:
    candidate = urlparse(candidate_url).hostname or ""
    source = urlparse(source_url).hostname or ""
    candidate = candidate.casefold().removeprefix("www.")
    source = source.casefold().removeprefix("www.")
    return bool(
        candidate
        and source
        and (candidate == source or candidate.endswith(f".{source}") or source.endswith(f".{candidate}"))
    )


def _offer_details(value: Any, base_url: str) -> tuple[float | None, float | None, str | None, str | None]:
    prices: list[float] = []
    currencies: list[str] = []
    ticket_url: str | None = None
    for offer in _as_list(value):
        if not isinstance(offer, Mapping):
            continue
        for key in ("price", "lowPrice", "highPrice", "minPrice", "maxPrice"):
            price = _number(offer.get(key))
            if price is not None and 0 <= price <= 100_000:
                prices.append(price)
        currency = _first_text(offer.get("priceCurrency"))
        if currency and re.fullmatch(r"[A-Za-z]{3}", currency):
            currencies.append(currency.upper())
        ticket_url = ticket_url or _canonical_http_url(offer.get("url"), base_url)
        nested = offer.get("offers")
        if nested:
            low, high, nested_currency, nested_url = _offer_details(nested, base_url)
            prices.extend(price for price in (low, high) if price is not None)
            if nested_currency:
                currencies.append(nested_currency)
            ticket_url = ticket_url or nested_url
    return (
        min(prices) if prices else None,
        max(prices) if prices else None,
        currencies[0] if currencies else None,
        ticket_url,
    )


def _normalize_status(value: Any) -> str:
    status = re.sub(r"\W+", "", (_first_text(value) or "").casefold())
    if "cancel" in status:
        return "cancelled"
    if "postpon" in status or "report" in status:
        return "postponed"
    if "soldout" in status or "complet" in status:
        return "sold_out"
    return "scheduled"


def _clean_description(value: Any) -> str | None:
    text = _first_text(value)
    if not text:
        return None
    cleaned = re.sub(r"<[^>]+>", " ", unescape(text))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:6000] or None


def _haversine_km(left_lat: float, left_lon: float, right_lat: float, right_lon: float) -> float:
    radians = math.radians
    delta_lat = radians(right_lat - left_lat)
    delta_lon = radians(right_lon - left_lon)
    value = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(radians(left_lat))
        * math.cos(radians(right_lat))
        * math.sin(delta_lon / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def _event_quality(event: Event) -> int:
    score = 44
    score += 10 if event.ends_at else 0
    score += 12 if event.venue_name or event.address else 0
    score += 8 if event.city else 0
    score += 8 if event.description and len(event.description) >= 40 else 0
    score += 6 if event.image_url else 0
    score += 5 if event.ticket_url else 0
    score += 4 if event.category else 0
    score += 3 if event.latitude is not None and event.longitude is not None else 0
    return min(100, score)


def _event_from_json_ld(
    raw: Mapping[str, Any],
    page_url: str,
    category: str | None,
    *,
    timezone_name: str = "Europe/Zurich",
    city_name: str | None = "Genève",
    city_latitude: float | None = 46.2044,
    city_longitude: float | None = 6.1432,
    country_code: str | None = "CH",
) -> Event | None:
    if not _has_event_type(raw.get("@type")):
        return None
    title = _first_text(raw.get("name") or raw.get("headline"))
    start_text = _first_text(raw.get("startDate"))
    starts_at = _iso_datetime(start_text, timezone_name)
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

    city = _first_text(address_value.get("addressLocality")) if isinstance(address_value, Mapping) else None
    region = _first_text(address_value.get("addressRegion")) if isinstance(address_value, Mapping) else None
    json_country = _first_text(address_value.get("addressCountry")) if isinstance(address_value, Mapping) else None
    latitude = _number(geo.get("latitude")) if isinstance(geo, Mapping) else None
    longitude = _number(geo.get("longitude")) if isinstance(geo, Mapping) else None
    warnings: list[str] = []
    if (latitude is None) != (longitude is None):
        warnings.append("incomplete_coordinates")
        latitude = longitude = None
    if latitude is not None and longitude is not None:
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            warnings.append("invalid_coordinates")
            latitude = longitude = None
        elif city_latitude is not None and city_longitude is not None:
            if _haversine_km(latitude, longitude, city_latitude, city_longitude) > 250:
                warnings.append("coordinates_outside_source_area")
                latitude = longitude = None

    price_min, price_max, currency, ticket_url = _offer_details(raw.get("offers"), page_url)
    source_url = _canonical_http_url(raw.get("url") or raw.get("@id"), page_url) or page_url
    if not _source_host_matches(source_url, page_url):
        warnings.append("off_domain_source_url")
        source_url = page_url
    organizer = raw.get("organizer") if isinstance(raw.get("organizer"), Mapping) else {}
    genre_values = _as_list(raw.get("genre") or raw.get("eventType") or raw.get("category"))
    genres = tuple(dict.fromkeys(filter(None, (_first_text(value) for value in genre_values))))
    all_day = bool(start_text and re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_text))
    ends_at = _iso_datetime(raw.get("endDate"), timezone_name)
    if all_day:
        try:
            start_date = datetime.fromisoformat(starts_at)
            if ends_at:
                ends_at = (datetime.fromisoformat(ends_at) + timedelta(days=1)).isoformat()
            else:
                ends_at = (start_date + timedelta(days=1)).isoformat()
        except (TypeError, ValueError):
            pass

    event = Event(
        title=title[:240],
        starts_at=starts_at,
        ends_at=ends_at,
        source_url=source_url,
        description=_clean_description(raw.get("description")),
        venue_name=_first_text(location.get("name")) if isinstance(location, Mapping) else None,
        address=address,
        latitude=latitude,
        longitude=longitude,
        category=_first_text(raw.get("eventType")) or category,
        ticket_url=ticket_url,
        image_url=_canonical_http_url(raw.get("image"), source_url),
        is_free=(raw.get("isAccessibleForFree") is True) or price_min == 0,
        external_identifier=_first_text(raw.get("identifier") or raw.get("@id")),
        timezone=timezone_name,
        time_precision="date" if all_day else "exact",
        all_day=all_day,
        city=city or city_name,
        region=region,
        country_code=json_country or country_code,
        organizer_name=_first_text(raw.get("organizer")),
        organizer_url=_canonical_http_url(organizer.get("url") or organizer.get("@id"), page_url),
        status=_normalize_status(raw.get("eventStatus")),
        language=_first_text(raw.get("inLanguage")),
        genres=genres,
        capacity=int(value) if (value := _number(raw.get("maximumAttendeeCapacity"))) else None,
        price_min=price_min,
        price_max=price_max,
        currency=currency or _currency_for_country(json_country) or _currency_for_country(country_code),
        warnings=tuple(warnings),
    )
    return replace(event, quality_score=_event_quality(event))


def _decode_json_documents(value: str) -> list[Any]:
    cleaned = value.strip().removeprefix("<!--").removesuffix("-->").strip().rstrip(";")
    if not cleaned:
        return []
    try:
        return [json.loads(cleaned)]
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        documents: list[Any] = []
        position = 0
        while position < len(cleaned):
            match = re.search(r"[\[{]", cleaned[position:])
            if not match:
                break
            position += match.start()
            try:
                document, end = decoder.raw_decode(cleaned, position)
            except json.JSONDecodeError:
                position += 1
                continue
            documents.append(document)
            position = end
        return documents


def extract_json_ld_events(
    html: str,
    page_url: str,
    category: str = "concerts",
    *,
    timezone_name: str = "Europe/Zurich",
    city_name: str | None = "Genève",
    city_latitude: float | None = 46.2044,
    city_longitude: float | None = 6.1432,
    country_code: str | None = "CH",
) -> list[Event]:
    parser = AgendaHTMLParser()
    parser.feed(html)
    events: list[Event] = []
    seen: set[tuple[str, str, str]] = set()
    for block in parser.json_ld:
        for document in _decode_json_documents(block):
            for raw in _iter_json_objects(document):
                event = _event_from_json_ld(
                    raw,
                    page_url,
                    category,
                    timezone_name=timezone_name,
                    city_name=city_name,
                    city_latitude=city_latitude,
                    city_longitude=city_longitude,
                    country_code=country_code,
                )
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
                        "timePrecision": {"type": ["string", "null"]},
                        "allDay": {"type": ["boolean", "null"]},
                        "venueName": {"type": ["string", "null"]},
                        "address": {"type": ["string", "null"]},
                        "city": {"type": ["string", "null"]},
                        "countryCode": {"type": ["string", "null"]},
                        "latitude": {"type": ["number", "null"]},
                        "longitude": {"type": ["number", "null"]},
                        "status": {"type": ["string", "null"]},
                        "language": {"type": ["string", "null"]},
                        "category": {"type": ["string", "null"]},
                        "genres": {"type": ["array", "null"], "items": {"type": "string"}},
                        "capacity": {"type": ["integer", "null"]},
                        "priceMin": {"type": ["number", "null"]},
                        "priceMax": {"type": ["number", "null"]},
                        "currency": {"type": ["string", "null"]},
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
                        f"Une ligne par occurrence, dates ISO 8601 dans {source.timezone}, lien officiel dans sourceUrl. "
                        "Ne transforme jamais une heure inconnue en minuit. N'invente aucune coordonnée, prix, "
                        "genre, capacité ou information absente et ignore les éléments de navigation."
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
        starts_at = _iso_datetime(raw.get("startDate"), source.timezone)
        if not title or not starts_at or re.search(
            r"(?i)(gift\s*card|carte\s*cadeau|newsletter|privacy|cookie|membership|contact|faq)",
            title,
        ):
            continue
        source_url = _canonical_http_url(raw.get("sourceUrl"), page_url) or page_url
        if not _source_host_matches(source_url, page_url):
            source_url = page_url
            warnings = ["off_domain_source_url"]
        else:
            warnings = []
        latitude = _number(raw.get("latitude"))
        longitude = _number(raw.get("longitude"))
        if (latitude is None) != (longitude is None):
            latitude = longitude = None
            warnings.append("incomplete_coordinates")
        if latitude is not None and longitude is not None:
            if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                latitude = longitude = None
                warnings.append("invalid_coordinates")
            elif source.latitude is not None and source.longitude is not None:
                if _haversine_km(latitude, longitude, source.latitude, source.longitude) > 250:
                    latitude = longitude = None
                    warnings.append("coordinates_outside_source_area")
        price_min = _number(raw.get("priceMin"))
        price_max = _number(raw.get("priceMax"))
        if price_min is not None and price_max is not None and price_min > price_max:
            price_min, price_max = price_max, price_min
        currency = (_first_text(raw.get("currency")) or "").upper() or None
        if currency and not re.fullmatch(r"[A-Z]{3}", currency):
            currency = None
        currency = currency or _currency_for_country(
            _first_text(raw.get("countryCode")) or source.country_code
        )
        all_day = raw.get("allDay") is True or bool(
            re.fullmatch(r"\d{4}-\d{2}-\d{2}", _first_text(raw.get("startDate")) or "")
        )
        ends_at = _iso_datetime(raw.get("endDate"), source.timezone)
        if all_day:
            try:
                if ends_at and re.fullmatch(
                    r"\d{4}-\d{2}-\d{2}", _first_text(raw.get("endDate")) or ""
                ):
                    ends_at = (datetime.fromisoformat(ends_at) + timedelta(days=1)).isoformat()
                elif not ends_at:
                    ends_at = (datetime.fromisoformat(starts_at) + timedelta(days=1)).isoformat()
            except ValueError:
                pass
        event = Event(
            title=title[:240],
            starts_at=starts_at,
            ends_at=ends_at,
            source_url=source_url,
            description=_clean_description(raw.get("description")),
            venue_name=_first_text(raw.get("venueName")),
            address=_first_text(raw.get("address")),
            latitude=latitude,
            longitude=longitude,
            category=_first_text(raw.get("category")) or source.category,
            ticket_url=_canonical_http_url(raw.get("ticketUrl"), source_url),
            image_url=_canonical_http_url(raw.get("imageUrl"), source_url),
            is_free=raw.get("isFree") is True or price_min == 0,
            external_identifier=_first_text(raw.get("externalId")),
            timezone=source.timezone,
            time_precision="date" if all_day else (_first_text(raw.get("timePrecision")) or "exact"),
            all_day=all_day,
            city=_first_text(raw.get("city")) or source.city,
            country_code=_first_text(raw.get("countryCode")) or source.country_code,
            status=_normalize_status(raw.get("status")),
            language=_first_text(raw.get("language")),
            genres=tuple(
                dict.fromkeys(
                    filter(None, (_first_text(value) for value in _as_list(raw.get("genres"))))
                )
            ),
            capacity=int(value) if (value := _number(raw.get("capacity"))) and value <= 1_000_000 else None,
            price_min=price_min if price_min is not None and 0 <= price_min <= 100_000 else None,
            price_max=price_max if price_max is not None and 0 <= price_max <= 100_000 else None,
            currency=currency,
            warnings=tuple(warnings),
        )
        if _future_event(event):
            scored = replace(event, quality_score=_event_quality(event))
            if scored.quality_score >= 48:
                events.append(scored)
    return events


class SupabaseREST:
    def __init__(self, url: str, service_key: str, timeout: int) -> None:
        self.url = url.rstrip("/")
        self.headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        self.timeout = timeout

    def sources(self, source_ids: Sequence[str], city_slug: str | None = None) -> list[Source]:
        query = {
            "select": (
                "id,name,base_url,category_slug,page_count,metadata,"
                "city:cities(name,timezone,latitude,longitude,country:countries(code))"
            ),
            "status": "eq.active",
            "is_authorized": "eq.true",
            "is_verified": "eq.true",
            "order": "priority.asc,name.asc",
        }
        if city_slug:
            city_rows = _request_json(
                f"{self.url}/rest/v1/cities?slug=eq.{city_slug}&select=id&limit=1",
                headers=self.headers,
                timeout=self.timeout,
            )
            if not city_rows:
                raise CollectorError(f"The {city_slug!r} city row is missing in Supabase")
            query["city_id"] = f"eq.{city_rows[0]['id']}"
        if source_ids:
            query["id"] = f"in.({','.join(source_ids)})"
        rows = _request_json(
            f"{self.url}/rest/v1/data_sources?{urlencode(query)}",
            headers=self.headers,
            timeout=self.timeout,
        )
        sources: list[Source] = []
        for row in rows:
            if (row.get("metadata") or {}).get("derived_city_source") is True:
                continue
            if (row.get("metadata") or {}).get("import_only") is True:
                continue
            city = row.get("city") if isinstance(row.get("city"), Mapping) else {}
            country = city.get("country") if isinstance(city.get("country"), Mapping) else {}
            sources.append(Source(
                id=row["id"],
                name=row["name"],
                base_url=row["base_url"],
                category=row.get("category_slug"),
                page_count=max(1, min(int(row.get("page_count") or 1), 40)),
                metadata=row.get("metadata") or {},
                city=_first_text(city.get("name")) or city_slug or "",
                timezone=_first_text(city.get("timezone")) or "UTC",
                latitude=_number(city.get("latitude")),
                longitude=_number(city.get("longitude")),
                country_code=(_first_text(country.get("code")) or "").upper(),
            ))
        return sources

    def upsert(self, source_id: str, event: Event) -> Mapping[str, Any]:
        result = _request_json(
            f"{self.url}/rest/v1/rpc/upsert_ingested_event_v2",
            method="POST",
            headers=self.headers,
            payload=event.rpc_payload(source_id),
            timeout=self.timeout,
        )
        if isinstance(result, list):
            return result[0] if result else {}
        return result if isinstance(result, Mapping) else {}

    def enrich(self, event_id: str, event: Event) -> None:
        event_update: dict[str, Any] = {"quality_score": event.quality_score}
        if event.genres:
            event_update["genres"] = list(event.genres)
        if event.language:
            event_update["language"] = event.language[:10].lower()
        if event.status != "scheduled":
            event_update["status"] = event.status
        _request_json(
            f"{self.url}/rest/v1/events?id=eq.{event_id}",
            method="PATCH",
            headers=self.headers,
            payload=event_update,
            timeout=self.timeout,
        )
        occurrence_query = urlencode({"event_id": f"eq.{event_id}", "starts_at": f"eq.{event.starts_at}"})
        occurrence_update: dict[str, Any] = {
            "timezone": event.timezone,
            "time_precision": event.time_precision,
            "all_day": event.all_day,
            "status": event.status,
        }
        if event.capacity is not None:
            occurrence_update["capacity"] = event.capacity
        _request_json(
            f"{self.url}/rest/v1/event_occurrences?{occurrence_query}",
            method="PATCH",
            headers=self.headers,
            payload=occurrence_update,
            timeout=self.timeout,
        )
        if event.price_min is not None or event.price_max is not None or event.currency:
            ticket_update = {
                "price_min": event.price_min if event.price_min is not None else event.price_max,
                "price_max": event.price_max if event.price_max is not None else event.price_min,
                "is_free": event.is_free,
            }
            if event.currency:
                ticket_update["currency"] = event.currency
            _request_json(
                f"{self.url}/rest/v1/ticket_offers?event_id=eq.{event_id}",
                method="PATCH",
                headers=self.headers,
                payload=ticket_update,
                timeout=self.timeout,
            )


def _dedupe(events: Iterable[Event]) -> list[Event]:
    result: list[Event] = []
    seen: dict[tuple[str, str], int] = {}
    for event in events:
        if not _future_event(event):
            continue
        key = (event.external_identifier or event.source_url, event.starts_at[:16])
        if key in seen:
            index = seen[key]
            current = result[index]
            richer = event if event.quality_score > current.quality_score else current
            other = current if richer is event else event
            result[index] = replace(
                richer,
                description=(
                    other.description
                    if len(other.description or "") > len(richer.description or "")
                    else richer.description
                ),
                image_url=richer.image_url or other.image_url,
                ticket_url=richer.ticket_url or other.ticket_url,
                genres=tuple(dict.fromkeys((*richer.genres, *other.genres))),
                warnings=tuple(dict.fromkeys((*richer.warnings, *other.warnings))),
            )
            continue

        best_index: int | None = None
        best_score = 0.0
        for index, current in enumerate(result):
            try:
                delta = abs(
                    (
                        datetime.fromisoformat(current.starts_at.replace("Z", "+00:00"))
                        - datetime.fromisoformat(event.starts_at.replace("Z", "+00:00"))
                    ).total_seconds()
                )
            except ValueError:
                continue
            if delta > 4 * 3600:
                continue
            title_score = SequenceMatcher(None, current.title.casefold(), event.title.casefold()).ratio()
            if title_score < 0.7:
                continue
            venue_score = SequenceMatcher(
                None,
                (current.venue_name or current.address or "").casefold(),
                (event.venue_name or event.address or "").casefold(),
            ).ratio()
            date_score = max(0.0, 1 - delta / (4 * 3600))
            score = 0.55 * title_score + 0.25 * date_score + 0.20 * venue_score
            if score > best_score:
                best_score = score
                best_index = index
        if best_index is not None:
            current_start = datetime.fromisoformat(result[best_index].starts_at.replace("Z", "+00:00"))
            event_start = datetime.fromisoformat(event.starts_at.replace("Z", "+00:00"))
            if best_score >= 0.92 and abs((current_start - event_start).total_seconds()) <= 15 * 60:
                seen[key] = best_index
                current = result[best_index]
                result[best_index] = event if event.quality_score > current.quality_score else current
                continue
        seen[key] = len(result)
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
        if getattr(args, "direct_only", False):
            payload["directOnly"] = True
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
            print(
                json.dumps(
                    {
                        "completed": True,
                        "completed_with_errors": totals["failed"] > 0,
                        **totals,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
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
            page_events = extract_json_ld_events(
                html,
                page_url,
                source.category,
                timezone_name=source.timezone,
                city_name=source.city,
                city_latitude=source.latitude,
                city_longitude=source.longitude,
                country_code=source.country_code,
            )
            if args.follow_links and len(page_events) < 2:
                for detail_url in discover_event_links(html, page_url, args.follow_links):
                    try:
                        detail_html = _request_text(detail_url, timeout=args.timeout, retries=1)
                        page_events.extend(
                            extract_json_ld_events(
                                detail_html,
                                detail_url,
                                source.category,
                                timezone_name=source.timezone,
                                city_name=source.city,
                                city_latitude=source.latitude,
                                city_longitude=source.longitude,
                                country_code=source.country_code,
                            )
                        )
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
        sources = [
            Source(
                None,
                args.venue or urlparse(args.url).netloc,
                args.url,
                args.category,
                city=args.city_name,
                timezone=args.timezone,
                latitude=args.latitude,
                longitude=args.longitude,
                country_code=args.country_code,
            )
        ]
    else:
        if not database:
            raise CollectorError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to load the source registry; "
                "alternatively pass --url for a local dry run"
            )
        sources = database.sources(args.source_id, args.city_slug)
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
    parser.add_argument(
        "--direct-only",
        action="store_true",
        help="Edge mode: bypass Firecrawl and verify deterministic direct HTML/JSON-LD scraping",
    )
    parser.add_argument("--batch-size", type=int, default=3, choices=range(1, MAX_BATCH_SIZE + 1))
    parser.add_argument("--max-batches", type=int, default=100)
    parser.add_argument("--url", help="Direct-mode URL for an unregistered local dry run")
    parser.add_argument("--venue", help="Venue name used with --url")
    parser.add_argument(
        "--city-slug",
        default=None,
        help="Optional registered city slug in direct mode; omitted means every active world source",
    )
    parser.add_argument("--city-name", default="Genève", help="City hint used with --url")
    parser.add_argument("--country-code", default="CH", help="ISO country hint used with --url")
    parser.add_argument("--timezone", default="Europe/Zurich", help="IANA timezone used with --url")
    parser.add_argument("--latitude", type=float, default=46.2044, help="City latitude used with --url")
    parser.add_argument("--longitude", type=float, default=6.1432, help="City longitude used with --url")
    parser.add_argument("--category", default="concerts", choices=SUPPORTED_CATEGORIES)
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
