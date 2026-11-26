-- Retain a daily lunch or dinner until the midnight immediately following its Korean meal date.
CREATE FUNCTION jb.daily_kst_expiry(post_title text,post_body text,reference_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE ref_day date := (reference_at AT TIME ZONE 'Asia/Seoul')::date;
  heading text; parts text[]; yr integer; candidate date; best date;
BEGIN
  heading := nullif(regexp_replace(post_title,'^[[:space:]]+|[[:space:]]+$','','g'),'');
  IF heading IS NULL THEN
    SELECT line INTO heading FROM regexp_split_to_table(coalesce(post_body,''), E'\r?\n') WITH ORDINALITY AS lines(line,pos)
      WHERE line ~ '[^[:space:]]' ORDER BY pos LIMIT 1;
  END IF;
  parts := regexp_match(heading,'(?:([0-9]{4})년[[:space:]]*)?([0-9]{1,2})월[[:space:]]*([0-9]{1,2})일');
  IF parts IS NOT NULL THEN
    FOR yr IN SELECT unnest(CASE WHEN parts[1] IS NOT NULL THEN ARRAY[parts[1]::integer]
      ELSE ARRAY[extract(year FROM ref_day)::integer,extract(year FROM ref_day)::integer-1,extract(year FROM ref_day)::integer+1] END) LOOP
      BEGIN candidate := make_date(yr,parts[2]::integer,parts[3]::integer);
      EXCEPTION WHEN datetime_field_overflow THEN CONTINUE; END;
      IF best IS NULL OR abs(candidate-ref_day)<abs(best-ref_day) THEN best := candidate; END IF;
    END LOOP;
  END IF;
  RETURN ((coalesce(best,ref_day)+1)::timestamp AT TIME ZONE 'Asia/Seoul');
END;
$$;
REVOKE ALL ON FUNCTION jb.daily_kst_expiry(text,text,timestamptz) FROM PUBLIC,anon,authenticated;

-- Same explicit heading rules as classifyMeal: weekly and ambiguous headings are not daily menus.
CREATE FUNCTION jb.is_daily_menu(post_title text,post_body text)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH heading AS (
   SELECT coalesce(nullif(regexp_replace(post_title,'^[[:space:]]+|[[:space:]]+$','','g'),''),
     (SELECT line FROM regexp_split_to_table(coalesce(post_body,''), E'\r?\n') WITH ORDINALITY AS lines(line,pos)
       WHERE line ~ '[^[:space:]]' ORDER BY pos LIMIT 1),'') AS value
 )
 SELECT value !~ '식단[[:space:]]*표|주간[[:space:]]*(식단|메뉴)'
   AND ((value ~ '중식') <> (value ~ '석식'))
   AND value ~ '(중식|석식)[[:space:]]*메[뉴누]' FROM heading;
$$;

-- Recover an absent publication timestamp from the stored post or a compact marker.
-- New markers store KST midnight after the meal date. Legacy lunch markers stored reference + 72h.
CREATE FUNCTION jb.daily_post_expiry(post_id text,post_title text,post_body text,
  published timestamptz,first_seen timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
 SELECT jb.daily_kst_expiry(post_title,post_body,coalesce(published,
   (SELECT first_seen_at FROM jb.meal_post WHERE id=post_id),
   (SELECT to_timestamp(last_run_at_epoch_ms/1000.0) - interval '24 hours'
    FROM jb.maintenance_state WHERE name='retention:daily:'||post_id),
   (SELECT to_timestamp(last_run_at_epoch_ms/1000.0) - interval '72 hours'
    FROM jb.maintenance_state WHERE name='retention:lunch:'||post_id AND run_token='expiry-only'),
   first_seen));
$$;
CREATE FUNCTION jb.daily_menu_expired(post_id text,post_title text,post_body text,
  published timestamptz,first_seen timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
 SELECT jb.is_daily_menu(post_title,post_body)
   AND jb.daily_post_expiry(post_id,post_title,post_body,published,first_seen)<=now();
$$;

-- The existing trigger remains attached while its function gains the daily policy.
CREATE OR REPLACE FUNCTION jb.guard_lunch_retention()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
DECLARE expiry timestamptz;
BEGIN
 IF jb.is_daily_menu(NEW.title,NEW.body) THEN
   PERFORM pg_advisory_xact_lock(hashtext('jb-meal-assets'));
   expiry := jb.daily_post_expiry(NEW.id,NEW.title,NEW.body,NEW.published_at,NEW.first_seen_at);
   INSERT INTO jb.maintenance_state(name,last_run_at_epoch_ms,run_token)
     VALUES('retention:daily:'||NEW.id,(extract(epoch FROM expiry)*1000)::bigint,'kst-daily-expiry')
     ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=excluded.last_run_at_epoch_ms
     WHERE jb.maintenance_state.last_run_at_epoch_ms<>excluded.last_run_at_epoch_ms;
   IF expiry<=now() THEN RETURN NULL; END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION jb.cleanup_expired_daily_menus()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
DECLARE expired_ids text[]; candidate_assets text[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('jb-meal-assets'));
 SELECT array_agg(id) INTO expired_ids FROM jb.meal_post
 WHERE jb.daily_menu_expired(id,title,body,published_at,first_seen_at);
 IF expired_ids IS NULL THEN RETURN; END IF;
 SELECT array_agg(DISTINCT asset_sha) INTO candidate_assets FROM jb.meal_image WHERE post_id=ANY(expired_ids);
 -- Keep only the id/expiry needed to reject old undated posts returned again by the source.
 INSERT INTO jb.maintenance_state(name,last_run_at_epoch_ms,run_token)
   SELECT 'retention:daily:'||id,(extract(epoch FROM jb.daily_post_expiry(id,title,body,published_at,first_seen_at))*1000)::bigint,'kst-daily-expiry'
   FROM jb.meal_post WHERE id=ANY(expired_ids)
   ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=excluded.last_run_at_epoch_ms;
 DELETE FROM jb.meal_post WHERE id=ANY(expired_ids);
 -- meal_image metadata cascades; only remove bytes formerly linked to these posts, now unreferenced.
 DELETE FROM jb.meal_asset a WHERE a.sha=ANY(candidate_assets)
   AND NOT EXISTS(SELECT 1 FROM jb.meal_image i WHERE i.asset_sha=a.sha);
END;
$$;
REVOKE ALL ON FUNCTION jb.is_daily_menu(text,text),jb.daily_post_expiry(text,text,text,timestamptz,timestamptz),
  jb.daily_menu_expired(text,text,text,timestamptz,timestamptz),jb.cleanup_expired_daily_menus()
  FROM PUBLIC,anon,authenticated;
-- DDL only: no existing records are removed at apply time. Activate the separate cron job after deployment.
