const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filter_rules (
      id SERIAL PRIMARY KEY,
      source_name TEXT UNIQUE NOT NULL,
      action TEXT NOT NULL DEFAULT 'intercept',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      vehicle TEXT,
      source TEXT,
      customer_message TEXT,
      status TEXT DEFAULT 'intercepted',
      conversation JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      contacted_at TIMESTAMPTZ,
      pushed_to_crm_at TIMESTAMPTZ
    );
  `);

  // Seed default filter rules if table is empty
  const { rowCount } = await pool.query('SELECT 1 FROM filter_rules LIMIT 1');
  if (rowCount === 0) {
    await pool.query(`
      INSERT INTO filter_rules (source_name, action, enabled) VALUES
        ('Cars.com',     'intercept',    true),
        ('AutoTrader',   'intercept',    true),
        ('Dealer site',  'intercept',    true),
        ('CarGurus',     'intercept',    true),
        ('Edmunds',      'intercept',    false),
        ('Phone',        'pass-through', false)
      ON CONFLICT DO NOTHING;
    `);
  }
  console.log('DB ready');
}

// ── Claude proxy ──────────────────────────────────────
async function callClaude(system, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

const SYSTEM_PROMPT = `You are a BDC assistant for Key Buick GMC in Ponte Vedra Beach, FL. You respond to inbound vehicle leads via text message.

Goals:
1. Respond within seconds — speed matters most
2. Confirm the customer's interest in the specific vehicle
3. Ask one qualifying question (timeline, trade-in, or financing)
4. Set an appointment or get them to confirm they want more info
5. Keep messages short, friendly, and conversational — not salesy

Rules:
- Never send more than 2 messages before the customer replies
- Always address the customer by first name
- If they ask for a price, share a ballpark and invite them in
- If they say they're ready to come in, immediately alert the sales team

Dealership hours: Mon–Sat 9am–7pm, Sun 12pm–5pm`;

// ── Routes: Filter Rules ──────────────────────────────
app.get('/api/rules', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM filter_rules ORDER BY id');
  res.json(rows);
});

app.patch('/api/rules/:id', async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query(
    'UPDATE filter_rules SET enabled=$1 WHERE id=$2 RETURNING *',
    [enabled, req.params.id]
  );
  res.json(rows[0]);
});

app.post('/api/rules', async (req, res) => {
  const { source_name, action, enabled } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO filter_rules (source_name, action, enabled) VALUES ($1,$2,$3) RETURNING *',
    [source_name, action ?? 'intercept', enabled ?? true]
  );
  res.json(rows[0]);
});

app.delete('/api/rules/:id', async (req, res) => {
  await pool.query('DELETE FROM filter_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Routes: Leads ─────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
});

app.get('/api/leads/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.patch('/api/leads/:id', async (req, res) => {
  const { status, conversation, contacted_at, pushed_to_crm_at } = req.body;
  const { rows } = await pool.query(
    `UPDATE leads SET
      status = COALESCE($1, status),
      conversation = COALESCE($2, conversation),
      contacted_at = COALESCE($3, contacted_at),
      pushed_to_crm_at = COALESCE($4, pushed_to_crm_at)
     WHERE id=$5 RETURNING *`,
    [status, conversation ? JSON.stringify(conversation) : null, contacted_at, pushed_to_crm_at, req.params.id]
  );
  res.json(rows[0]);
});

// ── Core: process a lead (used by both simulator + webhook) ──
async function processLead(leadData, res) {
  const { name, phone, vehicle, source, customer_message } = leadData;

  // Check filter rules
  const { rows: rules } = await pool.query(
    'SELECT * FROM filter_rules WHERE LOWER(source_name)=LOWER($1)',
    [source]
  );
  const rule = rules[0];
  const shouldIntercept = !rule || (rule.enabled && rule.action === 'intercept');

  if (!shouldIntercept) {
    // Pass-through — just log it
    const { rows } = await pool.query(
      `INSERT INTO leads (name, phone, vehicle, source, customer_message, status)
       VALUES ($1,$2,$3,$4,$5,'passed-through') RETURNING *`,
      [name, phone, vehicle, source, customer_message]
    );
    return res.json({ intercepted: false, lead: rows[0] });
  }

  // Create lead record
  const { rows } = await pool.query(
    `INSERT INTO leads (name, phone, vehicle, source, customer_message, status, conversation)
     VALUES ($1,$2,$3,$4,$5,'intercepted','[]') RETURNING *`,
    [name, phone, vehicle, source, customer_message]
  );
  const lead = rows[0];

  // Build first message for Claude
  const userMsg = `New inbound lead:
Customer name: ${name}
Vehicle of interest: ${vehicle}
Lead source: ${source}
Customer message: "${customer_message || 'No message provided'}"

Send your first SMS response to this customer.`;

  const conversation = [{ role: 'user', content: userMsg }];

  try {
    const aiReply = await callClaude(SYSTEM_PROMPT, conversation);
    conversation.push({ role: 'assistant', content: aiReply });

    await pool.query(
      `UPDATE leads SET conversation=$1, status='ai-engaged' WHERE id=$2`,
      [JSON.stringify(conversation), lead.id]
    );

    res.json({ intercepted: true, lead: { ...lead, conversation }, ai_reply: aiReply });
  } catch (err) {
    await pool.query(`UPDATE leads SET status='error' WHERE id=$1`, [lead.id]);
    res.status(500).json({ error: err.message });
  }
}

// ── Route: Simulator (manual lead entry) ─────────────
app.post('/api/leads/simulate', async (req, res) => {
  await processLead(req.body, res);
});

// ── Route: Webhook (Cars.com, AutoTrader, etc.) ───────
// Standard ADF/XML and JSON lead formats supported
app.post('/webhook/lead', async (req, res) => {
  let leadData;

  // Handle JSON leads
  if (req.is('application/json')) {
    const b = req.body;
    leadData = {
      name:             b.customer?.name || b.name || 'Unknown',
      phone:            b.customer?.phone || b.phone || '',
      vehicle:          b.vehicle?.year && b.vehicle?.make && b.vehicle?.model
                          ? `${b.vehicle.year} ${b.vehicle.make} ${b.vehicle.model}`
                          : b.vehicle || 'Unknown vehicle',
      source:           b.lead_source || b.source || 'Webhook',
      customer_message: b.comments || b.message || ''
    };
  } else {
    // Fallback for ADF/XML — treat body as-is and log it
    console.log('Non-JSON webhook received:', req.body);
    return res.status(200).send('OK'); // Don't crash on unknown format
  }

  await processLead(leadData, res);
});

// ── Route: Customer reply (simulated) ────────────────
app.post('/api/leads/:id/reply', async (req, res) => {
  const { message } = req.body;
  const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });

  const lead = rows[0];
  const conversation = Array.isArray(lead.conversation) ? lead.conversation : JSON.parse(lead.conversation || '[]');

  // Add customer reply
  conversation.push({ role: 'user', content: message });

  // Check if first real customer reply — mark contacted
  const customerReplies = conversation.filter(m =>
    m.role === 'user' && !m.content.startsWith('New inbound lead')
  );
  const isFirstReply = customerReplies.length === 1;

  try {
    const aiReply = await callClaude(SYSTEM_PROMPT, conversation);
    conversation.push({ role: 'assistant', content: aiReply });

    const newStatus = isFirstReply ? 'contacted' : lead.status;
    const contactedAt = isFirstReply ? new Date().toISOString() : lead.contacted_at;

    const { rows: updated } = await pool.query(
      `UPDATE leads SET conversation=$1, status=$2, contacted_at=$3 WHERE id=$4 RETURNING *`,
      [JSON.stringify(conversation), newStatus, contactedAt, lead.id]
    );

    res.json({
      lead: updated[0],
      ai_reply: aiReply,
      two_way_contact: isFirstReply
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Push to CRM ────────────────────────────────
app.post('/api/leads/:id/push-crm', async (req, res) => {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE leads SET status='pushed-to-crm', pushed_to_crm_at=$1 WHERE id=$2 RETURNING *`,
    [now, req.params.id]
  );
  // TODO: Add Tekion APC API call here when you have APC credentials
  res.json({ ok: true, lead: rows[0] });
});

// ── Route: Stats ──────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at::date = $1::date)           AS intercepted_today,
      COUNT(*) FILTER (WHERE status='contacted' AND created_at::date = $1::date) AS contacted_today,
      COUNT(*) FILTER (WHERE status='pushed-to-crm' AND created_at::date = $1::date) AS crm_today,
      COUNT(*) FILTER (WHERE status='passed-through' AND created_at::date = $1::date) AS passed_today
    FROM leads
  `, [today]);
  res.json(rows[0]);
});

// ── Catch-all ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Lead Intercept v2 running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
