-- Runs as the caller, never through the public Data API. Scheduling is an explicit cutover step.
CREATE OR REPLACE FUNCTION jb.aggregate_usage(p_enabled boolean DEFAULT true, p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, jb AS $$
DECLARE
  today date := (p_now AT TIME ZONE 'Asia/Seoul')::date;
  now_ms bigint := floor(extract(epoch FROM p_now) * 1000)::bigint;
  claimed text;
BEGIN
  INSERT INTO jb.maintenance_state AS s(name,last_run_at_epoch_ms,run_token)
  VALUES ('usage-daily-summary-v1:lease',now_ms,gen_random_uuid()::text)
  ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=EXCLUDED.last_run_at_epoch_ms,run_token=EXCLUDED.run_token
  WHERE s.last_run_at_epoch_ms <= now_ms - 55*60000 RETURNING run_token INTO claimed;
  IF claimed IS NULL THEN RETURN; END IF;
  IF p_enabled THEN
    -- Rebuild only scopes whose raw records are still retained. Older summaries stay intact.
    DELETE FROM jb.usage_daily_summary
    WHERE (audience='authenticated' AND metric_kind='activity' AND usage_date>=today-7)
       OR (audience='authenticated' AND metric_kind='feature' AND usage_date>=today-30)
       OR (audience='anonymous' AND metric_kind='activity' AND usage_date>=today-2);
    INSERT INTO jb.usage_daily_summary
    SELECT usage_date,'authenticated','activity',coalesce(client,'all'),activity,
      count(DISTINCT user_id),count(*),now_ms
    FROM jb.usage_user_day WHERE usage_date>=today-7
    GROUP BY GROUPING SETS ((usage_date,client,activity),(usage_date,activity));
    INSERT INTO jb.usage_daily_summary
    SELECT usage_date,'authenticated','feature',coalesce(client,'all'),feature_code,
      count(DISTINCT user_id),sum(use_count),now_ms
    FROM jb.usage_feature_day WHERE usage_date>=today-30
    GROUP BY GROUPING SETS ((usage_date,client,feature_code),(usage_date,feature_code));
    INSERT INTO jb.usage_daily_summary
    SELECT usage_date,'anonymous','activity',coalesce(client,'all'),activity,
      count(DISTINCT visitor_hash),count(*),now_ms
    FROM jb.usage_anonymous_day WHERE usage_date>=today-2
    GROUP BY GROUPING SETS ((usage_date,client,activity),(usage_date,activity));
  END IF;
  DELETE FROM jb.usage_anonymous_day WHERE usage_date<today-2;
  DELETE FROM jb.usage_user_day WHERE usage_date<today-7;
  DELETE FROM jb.usage_feature_day WHERE usage_date<today-30;
  DELETE FROM jb.usage_daily_summary WHERE usage_date<today-730;
  INSERT INTO jb.maintenance_state AS s VALUES ('usage-daily-summary-v1:success',now_ms,'success')
  ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=greatest(s.last_run_at_epoch_ms,EXCLUDED.last_run_at_epoch_ms),run_token='success';
END;
$$;
REVOKE ALL ON FUNCTION jb.aggregate_usage(boolean,timestamptz) FROM PUBLIC,anon,authenticated;
