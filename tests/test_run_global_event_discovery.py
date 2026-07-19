import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "run_global_event_discovery.py"
SPEC = importlib.util.spec_from_file_location("global_discovery_runner", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNNER
SPEC.loader.exec_module(RUNNER)


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
