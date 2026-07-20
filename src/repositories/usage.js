// Persisting usage events and reading them back for the cost report.

const { getPool } = require('../db/pool');

// Write one message's usage in a single statement rather than a row at a time —
// a voice note produces three events and there's no reason to pay three round
// trips to Neon for them.
async function insertUsageEvents(events, { businessId = null, messageSid = null } = {}) {
  if (!events || events.length === 0) return 0;

  const values = [];
  const params = [];
  events.forEach((e, i) => {
    const b = i * 9;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
    params.push(
      businessId, messageSid, e.kind, e.provider, e.model,
      e.inputTokens, e.outputTokens, e.audioSeconds, e.messages,
    );
  });

  const res = await getPool().query(
    `INSERT INTO usage_events
       (business_id, message_sid, kind, provider, model,
        input_tokens, output_tokens, audio_seconds, messages)
     VALUES ${values.join(',')}`,
    params,
  );
  return res.rowCount;
}

// Raw events over a window, newest business first. Costing happens in JS rather
// than SQL because the rates live in the environment, not the database.
async function usageSince(days) {
  const res = await getPool().query(
    `SELECT u.*, b.phone
       FROM usage_events u
       LEFT JOIN businesses b ON b.id = u.business_id
      WHERE u.created_at > CURRENT_TIMESTAMP - ($1 || ' days')::interval
      ORDER BY u.business_id NULLS LAST, u.created_at`,
    [String(days)],
  );
  return res.rows.map((r) => ({
    businessId: r.business_id,
    phone: r.phone,
    messageSid: r.message_sid,
    kind: r.kind,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    audioSeconds: r.audio_seconds === null ? null : Number(r.audio_seconds),
    messages: r.messages,
    createdAt: r.created_at,
  }));
}

module.exports = { insertUsageEvents, usageSince };
