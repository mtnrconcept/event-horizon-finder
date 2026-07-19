#!/usr/bin/env python3
"""Import EVENTA's worldwide city discovery targets from GeoNames dumps.

The importer deliberately uses the downloadable CC BY 4.0 files instead of a
metered geocoding API.  It selects the largest populated places
for every country, with a country-population-dependent ceiling, then sends
small idempotent batches to the service-role-only Supabase RPC
``import_global_city_targets``.

Secrets are read from ``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY`` only.
Use ``--dry-run`` to inspect the selection without writing anything.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
import unicodedata
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GEONAMES_BASE_URL = "https://download.geonames.org/export/dump"
COUNTRY_INFO_URL = f"{GEONAMES_BASE_URL}/countryInfo.txt"
CITIES_DATASET = "cities500"
CITIES_URL = f"{GEONAMES_BASE_URL}/{CITIES_DATASET}.zip"
USER_AGENT = (
    "EVENTA-GeoNames-City-Importer/1.0 "
    "(+https://github.com/mtnrconcept/event-horizon-finder)"
)
DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_BATCH_SIZE = 250
MAX_DUPLICATE_CITY_DISTANCE_KM = 6.0
EARTH_RADIUS_KM = 6_371.0088

_FEATURE_CODE_QUALITY = {
    "PPLC": 0,
    "PPLA": 1,
    "PPLA2": 2,
    "PPLA3": 3,
    "PPLA4": 4,
    "PPLG": 5,
    "PPL": 6,
}


class ImporterError(RuntimeError):
    """A safe importer failure that does not expose credentials."""


@dataclass(frozen=True)
class Country:
    code: str
    iso3: str
    name: str
    geonames_id: int
    area_sq_km: float
    population: int
    capital: str
    languages: tuple[str, ...]


@dataclass(frozen=True)
class City:
    geonames_id: int
    name: str
    ascii_name: str
    latitude: float
    longitude: float
    feature_code: str
    country_code: str
    admin1_code: str
    population: int
    timezone: str

    @property
    def is_capital(self) -> bool:
        return self.feature_code == "PPLC"


def adaptive_city_limit(country_population: int, available: int | None = None) -> int:
    """Return the auditable 1/3/8/15/25/40/50 selection ceiling."""

    population = max(0, int(country_population or 0))
    if population < 100_000:
        selected = 1
    elif population < 1_000_000:
        selected = 3
    elif population < 5_000_000:
        selected = 8
    elif population < 20_000_000:
        selected = 15
    elif population < 50_000_000:
        selected = 25
    elif population < 100_000_000:
        selected = 40
    else:
        selected = 50
    if available is not None:
        return min(selected, max(0, int(available)))
    return selected


def _integer(value: str) -> int:
    try:
        return max(0, int(value.strip() or 0))
    except (TypeError, ValueError):
        return 0


def _nonnegative_float(value: str) -> float:
    try:
        return max(0.0, float(value.strip() or 0))
    except (TypeError, ValueError):
        return 0.0


def _language_tags(value: str) -> tuple[str, ...]:
    output: list[str] = []
    seen: set[str] = set()
    for raw in value.split(","):
        tag = raw.strip().replace("_", "-")
        if not tag:
            continue
        normalized = tag.split("-", 1)[0].lower()
        if not normalized.isalpha() or not 2 <= len(normalized) <= 3:
            continue
        if normalized not in seen:
            seen.add(normalized)
            output.append(normalized)
    return tuple(output or ["en"])


def parse_country_info(text: str) -> dict[str, Country]:
    countries: dict[str, Country] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        columns = line.split("\t")
        if len(columns) < 17:
            continue
        code = columns[0].upper().strip()
        if len(code) != 2 or not code.isalpha():
            continue
        countries[code] = Country(
            code=code,
            iso3=columns[1].upper().strip(),
            name=columns[4].strip() or code,
            capital=columns[5].strip(),
            area_sq_km=_nonnegative_float(columns[6]),
            population=_integer(columns[7]),
            languages=_language_tags(columns[15]),
            geonames_id=_integer(columns[16]),
        )
    return countries


def parse_cities(text: Iterable[str]) -> Iterator[City]:
    for line in text:
        columns = line.rstrip("\n").split("\t")
        if len(columns) < 19:
            continue
        try:
            latitude = float(columns[4])
            longitude = float(columns[5])
            geonames_id = int(columns[0])
        except ValueError:
            continue
        code = columns[8].upper().strip()
        if (
            len(code) != 2
            or not code.isalpha()
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
        ):
            continue
        yield City(
            geonames_id=geonames_id,
            name=columns[1].strip(),
            ascii_name=columns[2].strip() or columns[1].strip(),
            latitude=latitude,
            longitude=longitude,
            feature_code=columns[7].strip().upper(),
            country_code=code,
            admin1_code=columns[10].strip(),
            population=_integer(columns[14]),
            timezone=columns[17].strip() or "UTC",
        )


def _normalized_city_names(city: City) -> frozenset[str]:
    """Return conservative comparison keys for a GeoNames city record."""

    output: set[str] = set()
    for value in (city.name, city.ascii_name):
        decomposed = unicodedata.normalize("NFKD", value.casefold())
        without_marks = "".join(
            character
            for character in decomposed
            if unicodedata.category(character) != "Mn"
        )
        normalized = " ".join(
            "".join(
                character if character.isalnum() else " "
                for character in without_marks
            ).split()
        )
        if normalized:
            output.add(normalized)
    return frozenset(output)


def _distance_km(left: City, right: City) -> float:
    """Return the great-circle distance between two city centres."""

    left_latitude = math.radians(left.latitude)
    right_latitude = math.radians(right.latitude)
    latitude_delta = right_latitude - left_latitude
    longitude_delta = math.radians(right.longitude - left.longitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(left_latitude)
        * math.cos(right_latitude)
        * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, haversine)))


def _city_keeper_key(city: City) -> tuple[int, int, bool, str, int]:
    """Order duplicate candidates from the most useful record to the least."""

    return (
        -city.population,
        _FEATURE_CODE_QUALITY.get(city.feature_code, 99),
        not bool(city.admin1_code),
        city.ascii_name.casefold(),
        city.geonames_id,
    )


def _deduplicate_physical_cities(cities: Iterable[City]) -> list[City]:
    """Collapse cautious same-city matches while retaining the best record.

    A record is treated as a duplicate only when it shares a normalized primary
    or ASCII name, belongs to the same country (guaranteed by the caller), has
    compatible admin-1 metadata, and lies at most six kilometres from a better
    record.  Sorting by a stable quality key makes the retained record fully
    deterministic regardless of dump order.
    """

    retained: list[City] = []
    retained_by_name: dict[str, list[City]] = defaultdict(list)
    for city in sorted(cities, key=_city_keeper_key):
        names = _normalized_city_names(city)
        candidates = {
            candidate.geonames_id: candidate
            for name in names
            for candidate in retained_by_name[name]
        }
        duplicate = any(
            (
                not city.admin1_code
                or not candidate.admin1_code
                or city.admin1_code == candidate.admin1_code
            )
            and _distance_km(city, candidate) <= MAX_DUPLICATE_CITY_DISTANCE_KM
            for candidate in candidates.values()
        )
        if duplicate:
            continue
        retained.append(city)
        for name in names:
            retained_by_name[name].append(city)
    return retained


def select_city_targets(
    countries: dict[str, Country], cities: Iterable[City]
) -> list[tuple[Country, City, int, int]]:
    """Select the largest cities by population for every country.

    The returned tuple contains country, city, one-based population rank and
    the adaptive country ceiling. Capital status is retained as metadata, but
    it never displaces a more populous city from the requested top-N list.
    """

    grouped: dict[str, list[City]] = defaultdict(list)
    for city in cities:
        if city.country_code in countries and city.name:
            grouped[city.country_code].append(city)

    output: list[tuple[Country, City, int, int]] = []
    for code, country in sorted(countries.items()):
        available = sorted(
            _deduplicate_physical_cities(grouped.get(code, [])),
            key=lambda city: (
                -city.population,
                not city.is_capital,
                city.ascii_name.casefold(),
                city.geonames_id,
            ),
        )
        if not available:
            continue

        # Rank and selection order both reflect population. Capital status is
        # only a deterministic tie-breaker and remains available in metadata.
        rank_by_id = {
            city.geonames_id: rank
            for rank, city in enumerate(
                sorted(
                    available,
                    key=lambda city: (-city.population, city.geonames_id),
                ),
                start=1,
            )
        }
        ceiling = adaptive_city_limit(country.population, len(available))
        for city in available[:ceiling]:
            output.append((country, city, rank_by_id[city.geonames_id], ceiling))
    return output


def target_payload(country: Country, city: City, rank: int, ceiling: int) -> dict[str, Any]:
    return {
        "country_code": country.code,
        "country_iso3": country.iso3 or None,
        "country_name": country.name,
        "country_geonames_id": country.geonames_id or None,
        "country_area_sq_km": country.area_sq_km,
        "country_population": country.population,
        "country_languages": list(country.languages),
        "city_geonames_id": city.geonames_id,
        "city_name": city.name,
        "city_ascii_name": city.ascii_name,
        "search_names": list(dict.fromkeys((city.name, city.ascii_name))),
        "search_languages": list(country.languages or ("en",)),
        "latitude": city.latitude,
        "longitude": city.longitude,
        "timezone": city.timezone,
        "city_population": city.population,
        "country_population_rank": rank,
        "is_capital": city.is_capital,
        "feature_code": city.feature_code or None,
        "query_profile": {
            "country_city_limit": ceiling,
            "admin1_code": city.admin1_code or None,
            "preferred_locale": country.languages[0] if country.languages else "en",
            "source": f"GeoNames {CITIES_DATASET}",
            "source_license": "CC BY 4.0",
            "source_url": CITIES_URL,
        },
    }


def _download(url: str, destination: Path, *, refresh: bool) -> Path:
    if destination.exists() and not refresh:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"Accept": "*/*", "User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:  # noqa: S310
            content = response.read()
    except (HTTPError, URLError, TimeoutError) as error:
        raise ImporterError(f"Unable to download {url}: {error}") from error
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(content)
    temporary.replace(destination)
    return destination


def load_targets(cache_dir: Path, *, refresh: bool) -> list[dict[str, Any]]:
    country_path = _download(COUNTRY_INFO_URL, cache_dir / "countryInfo.txt", refresh=refresh)
    cities_path = _download(CITIES_URL, cache_dir / f"{CITIES_DATASET}.zip", refresh=refresh)
    countries = parse_country_info(country_path.read_text(encoding="utf-8"))
    try:
        with zipfile.ZipFile(cities_path) as archive:
            member = next(name for name in archive.namelist() if name.endswith(".txt"))
            with archive.open(member) as binary:
                lines = io.TextIOWrapper(binary, encoding="utf-8")
                selected = select_city_targets(countries, parse_cities(lines))
    except (zipfile.BadZipFile, StopIteration) as error:
        raise ImporterError(f"Invalid GeoNames archive: {cities_path}") from error
    return [target_payload(*row) for row in selected]


def _chunks(values: Sequence[dict[str, Any]], size: int) -> Iterator[list[dict[str, Any]]]:
    for offset in range(0, len(values), size):
        yield list(values[offset : offset + size])


def _rpc_import(
    supabase_url: str,
    service_key: str,
    rows: Sequence[dict[str, Any]],
    *,
    timeout: int,
) -> Any:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/rpc/import_global_city_targets"
    body = json.dumps({"_rows": rows}, ensure_ascii=False).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed Supabase endpoint.
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else None
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1_000]
        raise ImporterError(f"Supabase import failed with HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ImporterError(f"Supabase import failed: {error}") from error


def _rpc_reconcile(
    supabase_url: str,
    service_key: str,
    rows: Sequence[dict[str, Any]],
    *,
    timeout: int,
) -> int:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/rpc/reconcile_global_city_targets"
    payload = {
        "_country_codes": sorted({str(row["country_code"]).upper() for row in rows}),
        "_selected_geonames_ids": sorted(
            {int(row["city_geonames_id"]) for row in rows if row.get("city_geonames_id")}
        ),
    }
    if not payload["_country_codes"] or not payload["_selected_geonames_ids"]:
        raise ImporterError("Refusing to reconcile an empty GeoNames selection")
    request = Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed Supabase endpoint.
            raw = response.read().decode("utf-8", errors="replace")
            value = json.loads(raw) if raw else 0
            return int(value or 0)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1_000]
        raise ImporterError(
            f"Supabase reconciliation failed with HTTP {error.code}: {detail}"
        ) from error
    except (URLError, TimeoutError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise ImporterError(f"Supabase reconciliation failed: {error}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".cache/geonames"),
        help="Directory for the free GeoNames dumps",
    )
    parser.add_argument("--refresh", action="store_true", help="Download fresh dumps")
    parser.add_argument("--dry-run", action="store_true", help="Select and report without writing")
    parser.add_argument("--country", action="append", default=[], help="Restrict to an ISO2 code")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--output", type=Path, help="Write the selected JSON payload to this file")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        targets = load_targets(args.cache_dir, refresh=args.refresh)
        selected_codes = {str(code).upper() for code in args.country}
        if selected_codes:
            targets = [row for row in targets if row["country_code"] in selected_codes]
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(targets, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

        countries = len({row["country_code"] for row in targets})
        print(f"Selected {len(targets)} cities across {countries} countries from GeoNames.")
        if args.dry_run:
            return 0

        supabase_url = os.environ.get("SUPABASE_URL", "").strip()
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not supabase_url or not service_key:
            raise ImporterError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --dry-run is used"
            )
        batch_size = max(1, min(int(args.batch_size), 500))
        imported = 0
        batches = list(_chunks(targets, batch_size))
        for number, batch in enumerate(batches, start=1):
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    _rpc_import(supabase_url, service_key, batch, timeout=max(10, args.timeout))
                    imported += len(batch)
                    last_error = None
                    break
                except ImporterError as error:
                    last_error = error
                    if attempt < 2:
                        time.sleep(2**attempt)
            if last_error:
                raise last_error
            print(f"Imported batch {number}/{len(batches)} ({imported}/{len(targets)} cities).")
        disabled = _rpc_reconcile(
            supabase_url,
            service_key,
            targets,
            timeout=max(10, args.timeout),
        )
        print(f"Reconciled GeoNames selection; disabled {disabled} stale city targets.")
        return 0
    except (ImporterError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
