DO $persistence_circuit_smoke$
DECLARE
  test_domain CONSTANT TEXT := 'persistence-circuit-smoke.example.com';
  circuit_state TEXT;
  timeout_count INTEGER;
  circuit_open_until TIMESTAMPTZ;
BEGIN
  DELETE FROM private.global_persistence_domain_circuit_breakers
  WHERE domain = test_domain;

  PERFORM private.record_global_persistence_timeout_v1(
    test_domain,
    'rpc_upsert_ingested_event_v2_failed',
    '57014: smoke timeout 1'
  );
  PERFORM private.record_global_persistence_timeout_v1(
    test_domain,
    'rpc_upsert_ingested_event_v2_failed',
    '57014: smoke timeout 2'
  );
  PERFORM private.record_global_persistence_timeout_v1(
    test_domain,
    'rpc_upsert_ingested_event_v2_failed',
    '57014: smoke timeout 3'
  );

  SELECT circuit.state, circuit.consecutive_timeouts
  INTO circuit_state, timeout_count
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  WHERE circuit.domain = test_domain;

  IF circuit_state <> 'open' OR timeout_count <> 3 THEN
    RAISE EXCEPTION
      'three consecutive timeouts must open the circuit: state %, count %',
      circuit_state,
      timeout_count;
  END IF;

  UPDATE private.global_persistence_domain_circuit_breakers
  SET open_until = now() - interval '1 second'
  WHERE domain = test_domain;

  PERFORM private.record_global_persistence_timeout_v1(
    test_domain,
    'rpc_upsert_ingested_event_v2_failed',
    '57014: failed cooldown probe'
  );

  SELECT circuit.state, circuit.open_until
  INTO circuit_state, circuit_open_until
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  WHERE circuit.domain = test_domain;

  IF circuit_state <> 'open' OR circuit_open_until <= now() THEN
    RAISE EXCEPTION
      'a failed cooldown probe must reopen the circuit: state %, until %',
      circuit_state,
      circuit_open_until;
  END IF;

  UPDATE private.global_persistence_domain_circuit_breakers
  SET open_until = now() - interval '1 second'
  WHERE domain = test_domain;

  PERFORM private.record_global_persistence_success_v1(test_domain);

  SELECT circuit.state, circuit.consecutive_timeouts
  INTO circuit_state, timeout_count
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  WHERE circuit.domain = test_domain;

  IF circuit_state <> 'closed' OR timeout_count <> 0 THEN
    RAISE EXCEPTION
      'a successful cooldown probe must close the circuit: state %, count %',
      circuit_state,
      timeout_count;
  END IF;

  IF has_function_privilege(
    'anon',
    'public.global_persistence_circuit_breaker_status_v1()',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.global_persistence_circuit_breaker_status_v1()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'circuit status must remain server-only';
  END IF;

  DELETE FROM private.global_persistence_domain_circuit_breakers
  WHERE domain = test_domain;
END;
$persistence_circuit_smoke$;
