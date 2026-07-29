import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "run_global_event_discovery.py"
WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "discover-world-events.yml"
EDGE_FUNCTION = (
    Path(__file__).parents[1] / "supabase" / "functions" / "global-event-discovery" / "index.ts"
)
CRON_MIGRATION = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260726013522_global_discovery_supabase_cron_fallback.sql"
)
CRON_ROLLBACK = (
    Path(__file__).parents[1]
    / "supabase"
    / "rollback"
    / "20260726013522_global_discovery_supabase_cron_fallback_rollback.sql"
)
LEASE_REAPER_MIGRATION = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260728124509_global_discovery_lease_reaper.sql"
)
LEASE_REAPER_ROLLBACK = (
    Path(__file__).parents[1]
    / "supabase"
    / "rollback"
    / "20260728124509_global_discovery_lease_reaper_rollback.sql"
)
DAILY_DEDUPE_MIGRATION = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260729035348_daily_dedupe_random_worldwide_discovery.sql"
)
DAILY_DEDUPE_ROLLBACK = (
    Path(__file__).parents[1]
    / "supabase"
    / "rollback"
    / "20260729035348_daily_dedupe_random_worldwide_discovery_rollback.sql"
)
DAILY_DEDUPE_SMOKE = (
    Path(__file__).parents[1] / "tests" / "global-daily-dedupe-smoke.sql"
)
PERSISTENCE_CIRCUIT_MIGRATION = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260729072607_persistence_circuit_breaker.sql"
)
PERSISTENCE_CIRCUIT_ROLLBACK = (
    Path(__file__).parents[1]
    / "supabase"
    / "rollback"
    / "20260729072607_persistence_circuit_breaker_rollback.sql"
)
PERSISTENCE_CIRCUIT_SMOKE = (
    Path(__file__).parents[1]
    / "tests"
    / "global-persistence-circuit-breaker-smoke.sql"
)
SPEC = importlib.util.spec_from_file_location("global_discovery_runner", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNNER
SPEC.loader.exec_module(RUNNER)


def scheduled_workflow_default(workflow: str, name: str) -> int:
    pattern = (
        r"^\s*"
        + re.escape(name)
        + r":\s*\$\{\{[^\n]*\|\|\s*(\d+)\s*\}\}\s*$"
    )
    match = re.search(pattern, workflow, flags=re.MULTILINE)
    if not match:
        raise AssertionError(f"scheduled workflow default not found: {name}")
    return int(match.group(1))


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class FakeClient:
    def __init__(self, responses, secret="s" * 32):
        self.responses = iter(responses)
        self.secret = secret
        self.calls = []

    def call(self, action, payload=None):
        self.calls.append((action, payload))
        return next(self.responses)


class GlobalDiscoveryRunnerTests(unittest.TestCase):
    def test_plan_can_target_poland(self):
        parser = RUNNER.build_parser()
        args = parser.parse_args(["plan", "--country-code", "pl", "--country-code", "PL"])
        self.assertEqual(args.country_code, ["PL", "PL"])

        with self.assertRaises(SystemExit):
            parser.parse_args(["plan", "--country-code", "POL"])

        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")
        self.assertIn('body.countryCodes ?? body.country_codes', edge_function)
        self.assertIn('"list_due_global_city_targets_v2"', edge_function)

    def test_scheduled_profile_runs_every_fifteen_minutes_without_raising_hourly_capacity(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('- cron: "6,21,36,51 * * * *"', workflow)
        push_block = workflow.split("  push:", 1)[1].split("  pull_request:", 1)[0]
        self.assertIn('".github/workflows/discover-world-events.yml"', push_block)
        self.assertNotIn('"scripts/', push_block)
        self.assertNotIn('"supabase/', push_block)
        self.assertEqual(workflow.count("github.event_name == 'push'"), 8)
        self.assertGreaterEqual(
            workflow.count("vars.GLOBAL_DISCOVERY_ENABLED == 'true'"),
            2,
        )
        self.assertIn("inputs.plan_batches || 1", workflow)
        self.assertIn("inputs.search_batches || 3", workflow)
        self.assertIn("inputs.crawl_batches || 5", workflow)

        # run_worker_loop performs up to --max-batches calls for every spawned
        # process, so scheduled capacity is workers * batches * four slices.
        scheduled = {
            name: scheduled_workflow_default(workflow, name)
            for name in (
                "SEARCH_BATCHES",
                "SEARCH_WORKERS",
                "CRAWL_BATCHES",
                "CRAWL_WORKERS",
            )
        }
        self.assertEqual(
            scheduled,
            {
                "SEARCH_BATCHES": 3,
                "SEARCH_WORKERS": 4,
                "CRAWL_BATCHES": 5,
                "CRAWL_WORKERS": 4,
            },
        )
        self.assertEqual(
            scheduled["SEARCH_BATCHES"] * scheduled["SEARCH_WORKERS"] * 4,
            48,
        )
        self.assertEqual(
            scheduled["CRAWL_BATCHES"] * scheduled["CRAWL_WORKERS"] * 4,
            80,
        )
        self.assertNotIn("queue: max", workflow)
        self.assertIn(
            "cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' && inputs.deploy }}",
            workflow,
        )
        self.assertNotIn('json.load(open(".cache/global-event-discovery/state.json"', workflow)
        self.assertNotIn('--campaign-id "$campaign_id"', workflow)
        self.assertIn("Report 15-minute discovery health", workflow)
        self.assertIn("Report post-slice campaign status", workflow)
        self.assertGreaterEqual(
            workflow.count("tests/test_legal_public_event_projection_migration.py"),
            2,
        )
        self.assertIn("--no-state --timeout 30 --retries 1", workflow)
        self.assertGreaterEqual(
            workflow.count("mkdir -p .cache/global-event-discovery"),
            4,
        )
        self.assertIn("TARGET_DATE: ${{ github.event_name == 'workflow_dispatch'", workflow)
        self.assertGreaterEqual(workflow.count("TZ: Europe/Zurich"), 3)
        self.assertNotIn('- cron: "17 * * * *"', workflow)
        self.assertIn(
            "--batch-size 1 --max-batches \"$CRAWL_BATCHES\" "
            "--pause-seconds 3 --timeout 120",
            workflow,
        )

    def test_crawl_batch_does_not_reduce_the_persistence_batch(self):
        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")
        self.assertIn(
            "body.persistenceLimit ?? body.persistence_limit,\n"
            "    DEFAULT_PERSISTENCE_BATCH,",
            edge_function,
        )
        self.assertNotIn(
            "body.persistenceLimit ?? body.persistence_limit ?? body.limit ?? body.batch_size",
            edge_function,
        )
        self.assertIn('"upsert_ingested_event_serial_v1"', edge_function)
        self.assertNotIn('"upsert_ingested_event_v2"', edge_function)

    def test_supabase_cron_fallback_is_secretless_bounded_and_reversible(self):
        migration = CRON_MIGRATION.read_text(encoding="utf-8")
        rollback = CRON_ROLLBACK.read_text(encoding="utf-8")
        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")

        self.assertIn("CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog", migration)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pg_net", migration)
        self.assertIn("extensions.gen_random_bytes(32)", migration)
        self.assertIn("extensions.digest(request_token, 'sha256')", migration)
        self.assertIn("pg_advisory_xact_lock(", migration)
        self.assertIn("FOR worker_index IN 1..6 LOOP", migration)
        self.assertIn("'7,22,37,52 * * * *'", migration)
        self.assertIn("'global-discovery-supabase-fallback'", migration)
        self.assertIn("'persistence_limit', 25", migration)
        self.assertIn("zero_creation_alert", migration)
        self.assertIn("now() + interval '10 minutes'", migration)
        self.assertIn("token.claimed_at IS NULL", migration)
        self.assertNotRegex(migration, r"x-global-discovery-cron-token',\s*'[a-f0-9]{64}'")

        self.assertIn("cron.unschedule(existing_job_id)", rollback)
        self.assertIn("global_discovery_scheduler_tokens", rollback)
        self.assertNotIn("DROP EXTENSION", rollback)

        self.assertIn('"x-global-discovery-cron-token"', edge_function)
        self.assertIn('"claim_global_discovery_scheduler_token_v1"', edge_function)
        self.assertIn('"global_discovery_health_v1"', edge_function)
        self.assertIn('"global_discovery_scheduler_status_v1"', edge_function)

    def test_expired_leases_are_reaped_and_worker_claims_are_released(self):
        migration = LEASE_REAPER_MIGRATION.read_text(encoding="utf-8")
        rollback = LEASE_REAPER_ROLLBACK.read_text(encoding="utf-8")
        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")

        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.reap_global_discovery_expired_leases_v1(",
            migration,
        )
        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.release_global_discovery_worker_leases_v1(",
            migration,
        )
        self.assertIn("pg_try_advisory_xact_lock(", migration)
        self.assertGreaterEqual(migration.count("FOR UPDATE OF job SKIP LOCKED"), 3)
        self.assertGreaterEqual(migration.count("lease_expired_reaped"), 6)
        self.assertIn("power(", migration)
        self.assertGreaterEqual(
            migration.count("attempt_count = greatest(0, job.attempt_count - 1)"),
            3,
        )
        self.assertIn("'batch_size', 1", migration)
        self.assertIn("'persistence_limit', 6", migration)
        self.assertIn("120000", migration)
        self.assertNotIn("'persistence_limit', 25", migration)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.reap_global_discovery_expired_leases_v1(INTEGER)",
            migration,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.release_global_discovery_worker_leases_v1(UUID, INTEGER)",
            migration,
        )

        self.assertIn(
            "DROP FUNCTION IF EXISTS public.release_global_discovery_worker_leases_v1",
            rollback,
        )
        self.assertIn(
            "DROP FUNCTION IF EXISTS public.reap_global_discovery_expired_leases_v1",
            rollback,
        )
        self.assertIn("'persistence_limit', 25", rollback)

        self.assertIn("const WORKER_EXECUTION_BUDGET_MS = 105_000", edge_function)
        self.assertIn("const DEFAULT_PERSISTENCE_BATCH = 8", edge_function)
        self.assertIn("const MAX_PERSISTENCE_BATCH = 8", edge_function)
        self.assertIn("_limit: 1", edge_function)
        self.assertIn(
            "while (persistenceJobs.length < persistenceLimit)",
            edge_function,
        )
        self.assertIn("pageFetchBudget: DIRECT_PAGE_FETCH_BUDGET", edge_function)
        self.assertIn('"reap_global_discovery_expired_leases_v1"', edge_function)
        self.assertIn('"release_global_discovery_worker_leases_v1"', edge_function)
        self.assertIn("} finally {", edge_function)

    def test_daily_work_is_atomic_private_randomized_and_reversible(self):
        migration = DAILY_DEDUPE_MIGRATION.read_text(encoding="utf-8")
        rollback = DAILY_DEDUPE_ROLLBACK.read_text(encoding="utf-8")
        smoke = DAILY_DEDUPE_SMOKE.read_text(encoding="utf-8")
        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn(
            "CREATE TABLE IF NOT EXISTS private.global_discovery_daily_work",
            migration,
        )
        self.assertIn(
            "PRIMARY KEY (work_date, work_kind, work_key)",
            migration,
        )
        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.claim_global_discovery_daily_work_v1(",
            migration,
        )
        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.skip_global_event_persistence_duplicate_v1(",
            migration,
        )
        self.assertIn(
            "REVOKE ALL ON TABLE private.global_discovery_daily_work",
            migration,
        )
        self.assertIn(
            "FROM PUBLIC, anon, authenticated, service_role",
            migration,
        )
        self.assertIn("PARTITION BY persistence.event_key", migration)
        self.assertIn("error_code = 'deduplicated_backlog'", migration)
        self.assertIn("PARTITION BY country.id", migration)
        self.assertIn("ORDER BY target.priority DESC, random()", migration)
        self.assertIn("LANGUAGE plpgsql\nVOLATILE", migration)
        self.assertIn(
            '"claim_global_discovery_daily_work_v1"',
            edge_function,
        )
        self.assertIn(
            '"skip_global_event_persistence_duplicate_v1"',
            edge_function,
        )
        self.assertIn('"duplicate_work_same_day"', edge_function)
        self.assertIn("candidateLimit: 50", edge_function)
        self.assertIn("random: Math.random", edge_function)

        self.assertIn("first daily work claim must succeed", smoke)
        self.assertIn("the owning job must be allowed to retry", smoke)
        self.assertIn("a second job must not claim identical work", smoke)
        self.assertIn("--file tests/global-daily-dedupe-smoke.sql", workflow)

        self.assertIn("status = 'queued'", rollback)
        self.assertIn(
            "error_code IN ('deduplicated_backlog', 'duplicate_work_same_day')",
            rollback,
        )
        self.assertIn(
            "DROP TABLE IF EXISTS private.global_discovery_daily_work",
            rollback,
        )

    def test_persistence_timeouts_open_a_private_bounded_circuit(self):
        migration = PERSISTENCE_CIRCUIT_MIGRATION.read_text(encoding="utf-8")
        rollback = PERSISTENCE_CIRCUIT_ROLLBACK.read_text(encoding="utf-8")
        smoke = PERSISTENCE_CIRCUIT_SMOKE.read_text(encoding="utf-8")
        edge_function = EDGE_FUNCTION.read_text(encoding="utf-8")
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn(
            "CREATE TABLE IF NOT EXISTS private.global_persistence_domain_circuit_breakers",
            migration,
        )
        self.assertIn("available_slots := greatest(0, 2 - active_leases)", migration)
        self.assertIn("LIMIT claim_limit", migration)
        self.assertIn("LIMIT 500", migration)
        self.assertIn("active_crawl.domain", migration)
        self.assertIn("next_timeout_count >= 3", migration)
        self.assertIn("breaker.open_until <= now()", migration)
        self.assertIn("now() + interval '2 hours'", migration)
        self.assertIn("persistence.attempt_count >= 4", migration)
        self.assertIn("THEN 'persistence_timeout_exhausted'", migration)
        self.assertIn("'whatson.cityofsydney.nsw.gov.au'", migration)
        self.assertIn("'agenda.lesoir.be'", migration)
        self.assertIn("state.next_allowed_at", migration)
        self.assertIn(
            "REVOKE ALL ON TABLE private.global_persistence_domain_circuit_breakers",
            migration,
        )
        self.assertIn(
            '"global_persistence_circuit_breaker_status_v1"',
            edge_function,
        )
        self.assertIn("persistence_circuit_breakers:", edge_function)
        self.assertIn("three consecutive timeouts must open the circuit", smoke)
        self.assertIn("a failed cooldown probe must reopen the circuit", smoke)
        self.assertIn("a successful cooldown probe must close the circuit", smoke)
        self.assertIn(
            "--file tests/global-persistence-circuit-breaker-smoke.sql",
            workflow,
        )
        self.assertIn("state = 'closed'", rollback)
        self.assertIn("persistence_circuit_rollback_requeued", rollback)
        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.claim_global_event_persistence_jobs",
            rollback,
        )

    def test_normalizes_project_urls_and_local_stack(self):
        expected = (
            "https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/"
            "global-event-discovery"
        )
        self.assertEqual(
            RUNNER.normalize_supabase_function_url("xtwxmdbobehovnghfkes"),
            expected,
        )
        self.assertEqual(
            RUNNER.normalize_supabase_function_url(
                " https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/old/? "
            ),
            expected,
        )
        self.assertEqual(
            RUNNER.normalize_supabase_function_url("http://localhost:54321/"),
            "http://localhost:54321/functions/v1/global-event-discovery",
        )
        with self.assertRaises(RUNNER.RunnerError):
            RUNNER.normalize_supabase_function_url("http://example.com")

    def test_client_sends_secret_in_headers_not_json_body(self):
        secret = "top-secret-value-that-is-at-least-32-characters"
        captured = {}

        def fake_urlopen(request, timeout):
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse({"campaign_id": "campaign-1"})

        client = RUNNER.DiscoveryClient(
            "https://project.supabase.co/functions/v1/global-event-discovery",
            secret,
            timeout=12,
            retries=0,
        )
        with mock.patch.object(RUNNER, "urlopen", side_effect=fake_urlopen):
            result = client.call("status", {"campaign_id": "campaign-1"})

        lowered = {key.casefold(): value for key, value in captured["headers"].items()}
        self.assertEqual(lowered["x-global-scraper-secret"], secret)
        self.assertEqual(lowered["authorization"], f"Bearer {secret}")
        self.assertNotIn(secret, json.dumps(captured["body"]))
        self.assertEqual(captured["timeout"], 12)
        self.assertEqual(result["campaign_id"], "campaign-1")

    def test_worker_loop_resumes_and_stops_when_nothing_is_claimed(self):
        client = FakeClient(
            [
                {"campaignId": "campaign-1", "claimed": 2, "completed": 2},
                {"campaign_id": "campaign-1", "claimed": 0, "completed": 0},
                {"claimed": 99},
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            state = RUNNER.StateStore(Path(directory) / "state.json")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = RUNNER.run_worker_loop(
                    client,
                    state,
                    action="search",
                    campaign_id="campaign-1",
                    batch_size=5,
                    max_batches=20,
                    pause_seconds=0,
                )

            self.assertEqual(result.calls, 2)
            self.assertEqual(result.stop_reason, "idle")
            self.assertEqual(state.load_campaign_id(), "campaign-1")
            self.assertEqual(len(client.calls), 2)
            self.assertEqual(client.calls[0][1]["batch_size"], 5)
            lines = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(lines[-1]["stop_reason"], "idle")

    def test_worker_loop_can_drain_global_queue_without_campaign_state(self):
        client = FakeClient([{"claimed": 0, "completed": 0}])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = RUNNER.run_worker_loop(
                client,
                RUNNER.StateStore(None),
                action="crawl",
                campaign_id=None,
                batch_size=2,
                max_batches=3,
                pause_seconds=0,
            )

        self.assertEqual(result.stop_reason, "idle")
        self.assertEqual(client.calls, [("crawl", {"batch_size": 2})])

    def test_status_can_resolve_the_current_campaign_without_local_state(self):
        response = {
            "ok": True,
            "campaign": {"campaign_id": "campaign-current"},
            "global_discovery_backlog": {"search_backlog": 1},
        }
        stdout = io.StringIO()
        env = {
            "SUPABASE_URL": "https://project.supabase.co",
            "GLOBAL_SCRAPER_SECRET": "s" * 32,
        }
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(RUNNER, "urlopen", return_value=FakeResponse(response)) as request,
            contextlib.redirect_stdout(stdout),
        ):
            exit_code = RUNNER.main(["status", "--no-state"])

        self.assertEqual(exit_code, 0)
        body = json.loads(request.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(body["action"], "status")
        self.assertEqual(
            body["target_date"],
            (RUNNER.date.today() + RUNNER.timedelta(days=RUNNER.DEFAULT_LOOKAHEAD_DAYS)).isoformat(),
        )
        self.assertEqual(json.loads(stdout.getvalue())["campaign_id"], "campaign-current")

    def test_status_emits_github_warning_for_productive_zero_creation_window(self):
        response = {
            "ok": True,
            "campaign": {"campaign_id": "campaign-current"},
            "discovery_health": {
                "persistence_completed_90m": 185,
                "persistence_created_90m": 0,
                "persistence_updated_90m": 185,
                "zero_creation_alert": True,
            },
        }
        stdout = io.StringIO()
        stderr = io.StringIO()
        env = {
            "SUPABASE_URL": "https://project.supabase.co",
            "GLOBAL_SCRAPER_SECRET": "s" * 32,
            "GITHUB_ACTIONS": "true",
        }
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(RUNNER, "urlopen", return_value=FakeResponse(response)),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            exit_code = RUNNER.main(["status", "--no-state"])

        self.assertEqual(exit_code, 0)
        self.assertIn("::warning title=Worldwide discovery created 0 events::", stderr.getvalue())
        self.assertIn("185 updates, 0 creations", stderr.getvalue())
        self.assertTrue(json.loads(stdout.getvalue())["ok"])

    def test_worker_loop_is_bounded_for_an_unknown_response_shape(self):
        client = FakeClient([{"jobs": [{"id": 1}]}] * 4)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = RUNNER.run_worker_loop(
                client,
                RUNNER.StateStore(None),
                action="crawl",
                campaign_id="campaign-2",
                batch_size=2,
                max_batches=3,
                pause_seconds=0,
            )
        self.assertEqual(result.calls, 3)
        self.assertEqual(result.stop_reason, "batch_limit")
        self.assertEqual(len(client.calls), 3)

    def test_worker_loop_fails_on_http_200_logical_worker_error(self):
        client = FakeClient(
            [
                {
                    "ok": False,
                    "action": "crawl",
                    "claimed": 2,
                    "completed": 0,
                    "failed": 2,
                    "jobs": [{"ok": False, "error": "safe_fetch_proxy_required"}],
                }
            ]
        )
        with self.assertRaisesRegex(RUNNER.RunnerError, "crawl_worker_reported_failure:2"):
            RUNNER.run_worker_loop(
                client,
                RUNNER.StateStore(None),
                action="crawl",
                campaign_id="campaign-2",
                batch_size=2,
                max_batches=3,
                pause_seconds=0,
            )

    def test_plan_writes_resume_state_and_redacts_secret_output(self):
        secret = "never-print-this-secret-value-123456789"
        response = {
            "campaign": {"id": "campaign-3"},
            "has_more": False,
            "debug_secret": secret,
            "message": f"accepted {secret}",
        }

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            stdout = io.StringIO()
            stderr = io.StringIO()
            env = {
                "SUPABASE_URL": "https://project.supabase.co",
                "GLOBAL_SCRAPER_SECRET": secret,
            }
            with (
                mock.patch.dict(os.environ, env, clear=True),
                mock.patch.object(RUNNER, "urlopen", return_value=FakeResponse(response)),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                exit_code = RUNNER.main(
                    [
                        "plan",
                        "--target-date",
                        "2026-07-27",
                        "--state-file",
                        str(state_path),
                    ]
                )

            self.assertEqual(exit_code, 0, stderr.getvalue())
            self.assertNotIn(secret, stdout.getvalue())
            lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(lines[0]["campaign_id"], "campaign-3")
            self.assertEqual(lines[-1]["summary"]["stop_reason"], "no_more_work")
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["campaign_id"], "campaign-3")
            self.assertNotIn(secret, state_path.read_text(encoding="utf-8"))

    def test_extracts_compatible_response_keys(self):
        self.assertEqual(
            RUNNER.extract_campaign_id({"data": {"campaignId": "abc"}}),
            "abc",
        )
        self.assertEqual(
            RUNNER.infer_stop_reason({"queue": {"hasMore": False}}, "search"),
            "no_more_work",
        )
        self.assertEqual(
            RUNNER.infer_stop_reason({"crawl_remaining": "0"}, "crawl"),
            "queue_empty",
        )


if __name__ == "__main__":
    unittest.main()
