-- Lunch retention is based on publication time, falling back to first collection.
-- Small id/expiry markers prevent old upstream posts from being re-imported after deletion.
CREATE OR REPLACE FUNCTION jb.is_lunch_menu(post_title text, post_body text)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  WITH heading AS (
    SELECT coalesce(nullif(regexp_replace(post_title,'^[[:space:]]+|[[:space:]]+$','','g'),''),
      (SELECT regexp_replace(line,'^[[:space:]]+|[[:space:]]+$','','g') FROM regexp_split_to_table(coalesce(post_body,''), E'\r?\n') WITH ORDINALITY AS lines(line, position)
       WHERE line ~ '[^[:space:]]' ORDER BY position LIMIT 1),'') AS value
  )
  SELECT value ~ '중식[[:space:]]*메[뉴누]' AND value !~ '석식'
    AND value !~ '식단[[:space:]]*표|주간[[:space:]]*(식단|메뉴)' FROM heading;
$$;

CREATE OR REPLACE FUNCTION jb.lunch_menu_expired(post_id text, post_title text, post_body text,
  published timestamptz, first_seen timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
  SELECT jb.is_lunch_menu(post_title,post_body) AND
    least(coalesce((SELECT to_timestamp(last_run_at_epoch_ms / 1000.0)
      FROM jb.maintenance_state WHERE name='retention:lunch:' || post_id),'infinity'::timestamptz),
      coalesce(published,first_seen) + interval '72 hours') <= now();
$$;

CREATE OR REPLACE FUNCTION jb.guard_lunch_retention()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
BEGIN
  IF jb.is_lunch_menu(NEW.title,NEW.body) THEN
    PERFORM pg_advisory_xact_lock(hashtext('jb-meal-assets'));
    INSERT INTO jb.maintenance_state(name,last_run_at_epoch_ms,run_token)
      VALUES('retention:lunch:' || NEW.id,
        (extract(epoch FROM (coalesce(NEW.published_at,NEW.first_seen_at) + interval '72 hours')) * 1000)::bigint,
        'expiry-only')
      ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=least(jb.maintenance_state.last_run_at_epoch_ms,excluded.last_run_at_epoch_ms);
    IF jb.lunch_menu_expired(NEW.id,NEW.title,NEW.body,NEW.published_at,NEW.first_seen_at) THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meal_post_lunch_retention BEFORE INSERT OR UPDATE ON jb.meal_post
FOR EACH ROW EXECUTE FUNCTION jb.guard_lunch_retention();

CREATE OR REPLACE FUNCTION jb.cleanup_expired_lunch_menus()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,jb AS $$
BEGIN
  -- Same lock as image ingestion: never delete an asset while its references are being written.
  PERFORM pg_advisory_xact_lock(hashtext('jb-meal-assets'));
  INSERT INTO jb.maintenance_state(name,last_run_at_epoch_ms,run_token)
    SELECT 'retention:lunch:' || id,
      (extract(epoch FROM (coalesce(published_at,first_seen_at) + interval '72 hours')) * 1000)::bigint,'expiry-only'
    FROM jb.meal_post WHERE jb.is_lunch_menu(title,body)
    ON CONFLICT(name) DO UPDATE SET last_run_at_epoch_ms=least(jb.maintenance_state.last_run_at_epoch_ms,excluded.last_run_at_epoch_ms);
  DELETE FROM jb.meal_post WHERE jb.lunch_menu_expired(id,title,body,published_at,first_seen_at);
  -- meal_image and meal_weekly_menu references cascade with the expired post.
  DELETE FROM jb.meal_asset a WHERE NOT EXISTS(SELECT 1 FROM jb.meal_image i WHERE i.asset_sha=a.sha);
END;
$$;
REVOKE ALL ON FUNCTION jb.is_lunch_menu(text,text),
  jb.lunch_menu_expired(text,text,text,timestamptz,timestamptz),
  jb.guard_lunch_retention(),jb.cleanup_expired_lunch_menus() FROM PUBLIC,anon,authenticated;

-- Immediately remove historical expired lunch data; scheduling is installed by the operation file.
SELECT jb.cleanup_expired_lunch_menus();
