CREATE FUNCTION public.purge_operation_results(audit_id uuid, batch_size integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  removed uuid[];
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
    RAISE EXCEPTION 'Retention batch size must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT result.operation_id
    FROM public.admin_operation_results result
    JOIN public.admin_operations operation ON operation.id = result.operation_id
    WHERE operation.replay_expires_at <= statement_timestamp()
    ORDER BY operation.replay_expires_at, result.operation_id
    LIMIT batch_size FOR UPDATE OF result SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.admin_operation_results result USING candidates
    WHERE result.operation_id = candidates.operation_id RETURNING result.operation_id
  )
  SELECT coalesce(array_agg(operation_id ORDER BY operation_id), '{}'::uuid[]) INTO removed FROM deleted;
  IF cardinality(removed) > 0 THEN
    INSERT INTO public.audit_events (id, actor_type, actor_id, action, target_type, outcome, data)
    VALUES (audit_id, 'system', 'operation-retention', 'operation.results_purged', 'operation_result', 'success',
      jsonb_build_object('count', cardinality(removed), 'operationIds', to_jsonb(removed)));
  END IF;
  RETURN cardinality(removed);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.purge_operation_results(uuid, integer) FROM PUBLIC;
