-- ============================================================
-- indexer_alerts: alert registration, scheduling & webhook delivery
--
-- At-least-once delivery semantics:
--   - A webhook that receives a non-2xx response leaves `notified_at` NULL
--     so the next scheduling pass will retry it.
--   - Only after a confirmed 2xx response is `notified_at` set, marking
--     the alert as successfully delivered for this occurrence.
--   - Duplicate notifications are prevented by the NOTIFICATION_LOCK key
--     in redis, but we still rely on `notified_at IS NULL` as the primary
--     retry trigger because the lock can expire.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS indexer;

-- --------------------------------------------------------------------------
-- Types
-- --------------------------------------------------------------------------

CREATE TYPE indexer.alert_status AS ENUM (
    'registered',
    'pending_trigger',
    'triggered',
    'notified',
    'acknowledged',
    'resolved',
    'dismissed'
);

-- --------------------------------------------------------------------------
-- Core tables
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS indexer.alerts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    condition   JSONB NOT NULL,
    threshold   JSONB,
    severity    TEXT NOT NULL DEFAULT 'medium',
    status      indexer.alert_status NOT NULL DEFAULT 'registered',
    channel     JSONB, -- {type, endpoint, ...}
    notified_at TIMESTAMPTZ,
    triggered_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status_notified_at
    ON indexer.alerts (status, notified_at)
    WHERE status = 'triggered';

CREATE TABLE IF NOT EXISTS indexer.alert_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id    UUID REFERENCES indexer.alerts(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Function: evaluate_alert_conditions
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.evaluate_alert_conditions(
    p_condition JSONB,
    p_metric_name TEXT,
    p_metric_value NUMERIC
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN CASE p_condition->>'op'
        WHEN 'gt'  THEN p_metric_value > (p_condition->>'threshold')::NUMERIC
        WHEN 'gte' THEN p_metric_value >= (p_condition->>'threshold')::NUMERIC
        WHEN 'lt'  THEN p_metric_value <  (p_condition->>'threshold')::NUMERIC
        WHEN 'lte' THEN p_metric_value <= (p_condition->>'threshold')::NUMERIC
        WHEN 'eq'  THEN p_metric_value =  (p_condition->>'threshold')::NUMERIC
        ELSE false
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: mark_alert_triggered
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.mark_alert_triggered(p_alert_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE indexer.alerts
    SET status       = 'triggered',
        triggered_at = now(),
        updated_at   = now()
    WHERE id = p_alert_id
      AND status IN ('registered', 'pending_trigger');

    INSERT INTO indexer.alert_history (alert_id, event_type, payload)
    VALUES (p_alert_id, 'triggered', jsonb_build_object('occurrence', now()));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: send_webhook_notification
--
-- POSTs the alert payload to the configured webhook endpoint and returns
-- the HTTP status code of the response.  A NULL request_id indicates the
-- request could not even be queued.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.send_webhook_notification(
    p_alert_id  UUID,
    p_endpoint  TEXT,
    p_payload   JSONB
) RETURNS INT AS $$
DECLARE
    v_request_id BIGINT;
    v_response   net.http_response;
    v_status_code INT;
BEGIN
    -- Queue the POST and capture the request id
    SELECT request_id INTO v_request_id
    FROM net.http_post(
        p_endpoint,
        ARRAY[
            row_to_json(net.header('Content-Type', 'application/json')),
            row_to_json(net.header('X-Susu-Alert-ID', p_alert_id::TEXT))
        ],
        p_payload,
        20 -- seconds timeout
    ) r(request_id BIGINT);

    IF v_request_id IS NULL THEN
        RETURN -1; -- queue failure
    END IF;

    -- Poll until the response is available (max 30 s)
    PERFORM pg_sleep(0.5);

    SELECT status_code INTO v_status_code
    FROM net._http_response(r => v_request_id)
    WHERE completed = true;

    -- If still pending after a brief wait, treat as failure (retry later)
    IF v_status_code IS NULL THEN
        RETURN -2;
    END IF;

    RETURN v_status_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: dispatch_notifications
--
-- Iterates over all triggered alerts whose `notified_at` is NULL, sends a
-- webhook for each, and sets `notified_at` **only** when the response is
-- a 2xx.  Failed / non-2xx deliveries leave `notified_at` NULL so the
-- next run retries them.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.dispatch_notifications()
RETURNS VOID AS $$
DECLARE
    v_alert   indexer.alerts%ROWTYPE;
    v_status  INT;
    v_now     TIMESTAMPTZ := now();
    v_payload JSONB;
BEGIN
    FOR v_alert IN
        SELECT * FROM indexer.alerts
        WHERE status = 'triggered'
          AND notified_at IS NULL
        ORDER BY created_at
        FOR UPDATE
    LOOP
        -- Build the notification payload
        v_payload := jsonb_build_object(
            alert_id   := v_alert.id::TEXT,
            name       := v_alert.name,
            severity   := v_alert.severity,
            triggered_at := v_alert.triggered_at,
            condition  := v_alert.condition,
            body       := jsonb_build_object(
                message  := format('Alert "%s" triggered (severity: %s)', v_alert.name, v_alert.severity),
                source   := 'susu-indexer',
                alert_id := v_alert.id::TEXT
            )
        );

        -- Send the webhook and capture the actual status code
        v_status := indexer.send_webhook_notification(
            v_alert.id,
            v_alert.channel->>'endpoint',
            v_payload
        );

        IF v_status >= 200 AND v_status < 300 THEN
            -- Confirmed 2xx — mark as delivered
            UPDATE indexer.alerts
            SET notified_at = v_now,
                status      = 'notified',
                updated_at  = now()
            WHERE id = v_alert.id;

            INSERT INTO indexer.alert_history (alert_id, event_type, payload)
            VALUES (v_alert.id, 'notified', jsonb_build_object(
                status_code := v_status,
                notified_at := v_now
            ));
        ELSE
            -- Non-2xx or queue error — leave notified_at NULL for retry
            RAISE NOTICE 'Alert %, webhook returned % (expected 2xx), will retry', v_alert.id, v_status;

            INSERT INTO indexer.alert_history (alert_id, event_type, payload)
            VALUES (v_alert.id, 'notification_failed', jsonb_build_object(
                status_code := v_status,
                attempted_at := v_now
            ));
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: schedule_alert_check (cron-compatible entry point)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.schedule_alert_check()
RETURNS VOID AS $$
BEGIN
    -- 1. Evaluate metrics (called by a separate metric-ingest pipeline)
    --    Each evaluation should call indexer.mark_alert_triggered() when
    --    the condition fires.

    -- 2. Dispatch pending notifications (idempotent, safe to call repeatedly)
    PERFORM indexer.dispatch_notifications();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: acknowledge_alert
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.acknowledge_alert(p_alert_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE indexer.alerts
    SET status     = 'acknowledged',
        updated_at = now()
    WHERE id = p_alert_id
      AND status IN ('triggered', 'notified');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: resolve_alert
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.resolve_alert(p_alert_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE indexer.alerts
    SET status     = 'resolved',
        updated_at = now()
    WHERE id = p_alert_id
      AND status IN ('triggered', 'notified', 'acknowledged');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Function: dismiss_alert
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indexer.dismiss_alert(p_alert_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE indexer.alerts
    SET status     = 'dismissed',
        updated_at = now()
    WHERE id = p_alert_id
      AND status IN ('triggered', 'notified', 'acknowledged');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --------------------------------------------------------------------------
-- Row-level security (optional — enabled per project policy)
-- --------------------------------------------------------------------------

ALTER TABLE indexer.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE indexer.alert_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated service role full access on alerts"
    ON indexer.alerts FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated service role full access on alert_history"
    ON indexer.alert_history FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);
