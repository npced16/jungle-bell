-- Run only after secrets, external source access, test deliveries, and single-writer cutover pass.
-- Required Vault entries: jb_project_url (https://<ref>.supabase.co), jb_job_secret (same JOB_SECRET as Edge).
-- No secret literal belongs in this file or command history.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION jb.dispatch_job(job text)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
DECLARE project_url text; job_secret text; request_id bigint;
BEGIN
  IF job NOT IN ('collect-laundry','collect-meals','automate','push') THEN RAISE EXCEPTION 'Unknown job'; END IF;
  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name='jb_project_url';
  SELECT decrypted_secret INTO job_secret FROM vault.decrypted_secrets WHERE name='jb_job_secret';
  IF project_url IS NULL OR project_url !~ '^https://[a-z0-9]+[.]supabase[.]co$' OR length(job_secret)<32 OR job_secret IS NULL THEN
    RAISE EXCEPTION 'Job vault configuration is incomplete';
  END IF;
  SELECT net.http_post(
    url:=project_url || '/functions/v1/' || job,
    headers:=jsonb_build_object('Content-Type','application/json','x-job-secret',job_secret),
    body:='{}'::jsonb, timeout_milliseconds:=120000
  ) INTO request_id;
  RETURN request_id;
END;
$$;
REVOKE ALL ON FUNCTION jb.dispatch_job(text) FROM PUBLIC,anon,authenticated;

-- Fail before scheduling anything if the Vault configuration is absent.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='jb_project_url' AND decrypted_secret ~ '^https://[a-z0-9]+[.]supabase[.]co$')
     OR NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='jb_job_secret' AND length(decrypted_secret)>=32) THEN
    RAISE EXCEPTION 'Populate job Vault entries before activation';
  END IF;
END $$;
SELECT cron.schedule('jb-laundry','* * * * *',$job$SELECT jb.dispatch_job('collect-laundry')$job$);
SELECT cron.schedule('jb-meals','*/5 * * * *',$job$SELECT jb.dispatch_job('collect-meals')$job$);
-- 식사 직전(KST 11:50~11:59, 17:50~17:59)에는 1분 단위로 수집한다. pg_cron은 UTC 기준이다.
SELECT cron.schedule('jb-meals-mealtime','50-59 2,8 * * *',$job$SELECT jb.dispatch_job('collect-meals')$job$);
SELECT cron.schedule('jb-meals-continue','10 seconds',$job$
  SELECT jb.dispatch_job('collect-meals') WHERE EXISTS(SELECT 1 FROM jb.maintenance_state WHERE name IN ('collector:meals-include-pinned:cursor','collector:meals-default:cursor'))
$job$);
SELECT cron.schedule('jb-automate','* * * * *',$job$SELECT jb.dispatch_job('automate')$job$);
SELECT cron.schedule('jb-automate-continue','10 seconds',$job$
  SELECT jb.dispatch_job('automate') WHERE EXISTS(SELECT 1 FROM jb.maintenance_state WHERE name LIKE 'automation:%:cursor')
$job$);
SELECT cron.schedule('jb-push','5 seconds',$job$
  SELECT jb.dispatch_job('push') WHERE EXISTS(
    SELECT 1 FROM jb.notification_delivery d JOIN jb.notification n ON n.id=d.notification_id
    WHERE d.target_kind='push' AND d.status IN ('pending','retry')
      AND d.next_attempt_at_epoch_ms<=extract(epoch FROM now())*1000
      AND (d.lease_expires_at_epoch_ms IS NULL OR d.lease_expires_at_epoch_ms<=extract(epoch FROM now())*1000)
      AND n.expires_at_epoch_ms>extract(epoch FROM now())*1000)
$job$);
-- If USAGE_METRICS_ENABLED=false, change true to false here. Purging still runs.
SELECT cron.schedule('jb-usage','7 * * * *',$job$SELECT jb.aggregate_usage(true)$job$);
SELECT cron.schedule('jb-daily-meal-retention','* * * * *',$job$SELECT jb.cleanup_expired_daily_menus()$job$);
-- Project-wide pg_cron history; NULL end_time (unfinished runs) is preserved.
SELECT cron.schedule('jb-cron-history-retention','*/15 * * * *',$job$
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '72 hours'
$job$);
