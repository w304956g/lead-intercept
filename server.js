const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ── Database ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const DEFAULT_PROMPT = `You are Jake, a sales associate at a car dealership. You respond to inbound vehicle inquiries via text message on behalf of the dealership. You are warm, casual, and helpful — like a real salesperson who happens to be good at texting.

Your goals:
1. Make the customer feel like they reached a real person immediately
2. Confirm their interest in the specific vehicle they asked about
3. Ask one natural qualifying question — timeline, trade-in, or financing
4. Move toward an appointment or a commitment to keep talking
5. Keep every message short — 2-4 sentences maximum

Rules for how you write:
- Write exactly like a real person texting. Casual, natural, no corporate language
- Use the customer's first name once at the start, then drop it
- Never use bullet points, numbered lists, or formal greetings like "Hello" or "Good afternoon"
- Never use phrases like "I'd be happy to," "Certainly," "Great question," or anything that sounds like a chatbot
- Vary your sentence structure and message length every time — never follow the same pattern twice
- Occasional minor imperfections are fine — a lowercase start, a relaxed contraction, a short fragment. Real people text like that
- Never send more than 2 messages before the customer replies
- Never mention price unless they ask first
- If they ask for a price, give a real ballpark and immediately invite them in
- If they say they're ready to come in, express genuine enthusiasm and ask when works for them

If the customer directly asks whether you are a real person or an AI:
- Do not lie. Respond with something like: "I'm an automated assistant helping out for the dealership — but a real member of our team is going to be following up with you directly. They'll have everything we've talked about."
- Then immediately continue the conversation naturally

Tone examples:
- Good: "hey Marcus! yeah that Denali just came back in stock actually — are you thinking about financing or did you want to pay cash?"
- Good: "white is actually one of the harder ones to keep on the lot lol — we have one left. when were you thinking about coming in?"
- Bad: "Hello Marcus! I'd be happy to assist you with your inquiry about the 2025 GMC Sierra 1500 Denali."
- Bad: "Great question! Here are some options I can offer you:"

The customer should feel like they caught a salesperson between customers who picked up their phone and responded. Not like they submitted a form and got an auto-reply.`;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

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
      is_test BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      contacted_at TIMESTAMPTZ,
      pushed_to_crm_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false`).catch(() => {});

  // Seed admin user
  const { rowCount: uc } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (uc === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = crypto.createHash('sha256').update(adminPass).digest('hex');
    await pool.query(`INSERT INTO users (username,password_hash,role) VALUES ($1,$2,'admin')`, ['admin', hash]);
    console.log(`Admin created — user: admin  pass: ${adminPass}`);
  }

  // Seed filter rules
  const { rowCount: rc } = await pool.query('SELECT 1 FROM filter_rules LIMIT 1');
  if (rc === 0) {
    await pool.query(`
      INSERT INTO filter_rules (source_name,action,enabled) VALUES
        ('Cars.com','intercept',true),('AutoTrader','intercept',true),
        ('Dealer site','intercept',true),('CarGurus','intercept',true),
        ('Edmunds','intercept',false),('Phone','pass-through',false)
      ON CONFLICT DO NOTHING;
    `);
  }

  // Seed default prompt
  await pool.query(`
    INSERT INTO settings (key,value) VALUES ('system_prompt',$1)
    ON CONFLICT (key) DO NOTHING
  `, [DEFAULT_PROMPT]);

  console.log('DB ready');
}

// ── Auth helpers ──────────────────────────────────────
const hashPass = p => crypto.createHash('sha256').update(p).digest('hex');
const genToken = () => crypto.randomBytes(32).toString('hex');

async function getUserFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').find(c => c.trim().startsWith('session='));
  if (!match) return null;
  const token = match.trim().slice(8);
  const { rows } = await pool.query(
    `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
     WHERE s.token=$1 AND s.expires_at>NOW()`, [token]
  );
  return rows[0] || null;
}

function getToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').find(c => c.trim().startsWith('session='));
  return match ? match.trim().slice(8) : null;
}

async function requireAuth(req, res, next) {
  const openPaths = ['/', '/login', '/logout', '/login.html', '/marketing.html'];
  if (openPaths.includes(req.path) || req.path.startsWith('/webhook/') || req.path.match(/\.(css|js|png|ico|woff|woff2|jpg|svg)$/)) {
    return next();
  }
  const user = await getUserFromRequest(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes ───────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE username=$1 AND password_hash=$2',
    [username?.toLowerCase().trim(), hashPass(password || '')]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Invalid username or password' });
  const token = genToken();
  await pool.query('INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,$3)',
    [token, rows[0].id, new Date(Date.now() + 30*24*60*60*1000)]);
  await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [rows[0].id]);
  res.setHeader('Set-Cookie', `session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`);
  res.json({ ok: true, user: { username: rows[0].username, role: rows[0].role } });
});

app.post('/logout', async (req, res) => {
  const token = getToken(req);
  if (token) await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ username: req.user.username, role: req.user.role }));

// ── Users ─────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,username,role,created_at,last_login FROM users ORDER BY created_at');
  res.json(rows);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING id,username,role',
      [username.toLowerCase().trim(), hashPass(password), role || 'viewer']
    );
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPass(password), req.params.id]);
  res.json({ ok: true });
});

// ── Settings (prompt) ─────────────────────────────────
app.get('/api/settings/prompt', async (req, res) => {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='system_prompt'`);
  res.json({ prompt: rows[0]?.value || DEFAULT_PROMPT });
});

app.post('/api/settings/prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  await pool.query(
    `INSERT INTO settings (key,value,updated_at) VALUES ('system_prompt',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
    [prompt]
  );
  res.json({ ok: true });
});

// ── Claude ────────────────────────────────────────────
async function getPrompt() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='system_prompt'`);
  return rows[0]?.value || DEFAULT_PROMPT;
}

async function callClaude(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system, messages })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text || '';
}

// Randomized delay 45s-3min for humanized feel (simulator only uses 0 delay)
function randomDelay(min=45000, max=180000) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random()*(max-min)+min)));
}

// ── Filter rules ──────────────────────────────────────
app.get('/api/rules', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM filter_rules ORDER BY id');
  res.json(rows);
});
app.patch('/api/rules/:id', async (req, res) => {
  const { rows } = await pool.query('UPDATE filter_rules SET enabled=$1 WHERE id=$2 RETURNING *', [req.body.enabled, req.params.id]);
  res.json(rows[0]);
});
app.post('/api/rules', async (req, res) => {
  const { source_name, action, enabled } = req.body;
  const { rows } = await pool.query('INSERT INTO filter_rules (source_name,action,enabled) VALUES ($1,$2,$3) RETURNING *',
    [source_name, action||'intercept', enabled??true]);
  res.json(rows[0]);
});
app.delete('/api/rules/:id', async (req, res) => {
  await pool.query('DELETE FROM filter_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Leads ─────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const showTest = req.query.show_test === 'true';
  const q = showTest
    ? 'SELECT * FROM leads ORDER BY created_at DESC LIMIT 200'
    : 'SELECT * FROM leads WHERE is_test=false ORDER BY created_at DESC LIMIT 200';
  const { rows } = await pool.query(q);
  res.json(rows);
});

app.get('/api/leads/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.delete('/api/leads/:id', async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/leads', async (req, res) => {
  if (req.query.test_only === 'true') {
    const { rowCount } = await pool.query('DELETE FROM leads WHERE is_test=true');
    return res.json({ deleted: rowCount });
  }
  res.status(400).json({ error: 'Specify test_only=true' });
});

app.patch('/api/leads/:id', async (req, res) => {
  const { status, conversation, contacted_at, pushed_to_crm_at } = req.body;
  const { rows } = await pool.query(
    `UPDATE leads SET status=COALESCE($1,status),conversation=COALESCE($2,conversation),
     contacted_at=COALESCE($3,contacted_at),pushed_to_crm_at=COALESCE($4,pushed_to_crm_at)
     WHERE id=$5 RETURNING *`,
    [status, conversation?JSON.stringify(conversation):null, contacted_at, pushed_to_crm_at, req.params.id]
  );
  res.json(rows[0]);
});

// ── Process lead ──────────────────────────────────────
async function processLead(leadData, res, isTest=false, useDelay=false) {
  const { name, phone, vehicle, source, customer_message } = leadData;
  const systemPrompt = await getPrompt();

  const { rows: rules } = await pool.query('SELECT * FROM filter_rules WHERE LOWER(source_name)=LOWER($1)', [source]);
  const rule = rules[0];
  const intercept = !rule || (rule.enabled && rule.action === 'intercept');

  if (!intercept) {
    const { rows } = await pool.query(
      `INSERT INTO leads (name,phone,vehicle,source,customer_message,status,is_test)
       VALUES ($1,$2,$3,$4,$5,'passed-through',$6) RETURNING *`,
      [name,phone,vehicle,source,customer_message,isTest]
    );
    return res.json({ intercepted: false, lead: rows[0] });
  }

  const { rows } = await pool.query(
    `INSERT INTO leads (name,phone,vehicle,source,customer_message,status,conversation,is_test)
     VALUES ($1,$2,$3,$4,$5,'intercepted','[]',$6) RETURNING *`,
    [name,phone,vehicle,source,customer_message,isTest]
  );
  const lead = rows[0];

  const conversation = [{
    role: 'user',
    content: `New inbound lead:\nCustomer name: ${name}\nVehicle of interest: ${vehicle}\nLead source: ${source}\nCustomer message: "${customer_message||'none'}"\n\nSend your first text message to this customer.`
  }];

  try {
    // Apply humanized delay for real leads only
    if (useDelay) await randomDelay();

    const aiReply = await callClaude(systemPrompt, conversation);
    conversation.push({ role: 'assistant', content: aiReply });
    await pool.query(`UPDATE leads SET conversation=$1,status='ai-engaged' WHERE id=$2`,
      [JSON.stringify(conversation), lead.id]);
    res.json({ intercepted: true, lead: { ...lead, conversation }, ai_reply: aiReply });
  } catch(err) {
    await pool.query(`UPDATE leads SET status='error' WHERE id=$1`, [lead.id]);
    res.status(500).json({ error: err.message });
  }
}

// Simulator — no delay, marked as test
app.post('/api/leads/simulate', async (req, res) => processLead(req.body, res, true, false));

// Webhook — real leads get humanized delay
app.post('/webhook/lead', async (req, res) => {
  if (!req.is('application/json')) return res.status(200).send('OK');
  const b = req.body;
  await processLead({
    name: b.customer?.name || b.name || 'Unknown',
    phone: b.customer?.phone || b.phone || '',
    vehicle: b.vehicle?.year ? `${b.vehicle.year} ${b.vehicle.make} ${b.vehicle.model}` : b.vehicle || 'Unknown',
    source: b.lead_source || b.source || 'Webhook',
    customer_message: b.comments || b.message || ''
  }, res, false, true);
});

// ── Customer reply ────────────────────────────────────
app.post('/api/leads/:id/reply', async (req, res) => {
  const { message, use_delay } = req.body;
  const systemPrompt = await getPrompt();
  const { rows } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });

  const lead = rows[0];
  const conv = Array.isArray(lead.conversation) ? lead.conversation : JSON.parse(lead.conversation||'[]');
  conv.push({ role: 'user', content: message });

  const customerReplies = conv.filter(m => m.role==='user' && !m.content.startsWith('New inbound lead'));
  const isFirst = customerReplies.length === 1;

  try {
    if (use_delay) await randomDelay();
    const aiReply = await callClaude(systemPrompt, conv);
    conv.push({ role: 'assistant', content: aiReply });
    const { rows: updated } = await pool.query(
      `UPDATE leads SET conversation=$1,status=$2,contacted_at=$3 WHERE id=$4 RETURNING *`,
      [JSON.stringify(conv), isFirst?'contacted':lead.status, isFirst?new Date().toISOString():lead.contacted_at, lead.id]
    );
    res.json({ lead: updated[0], ai_reply: aiReply, two_way_contact: isFirst });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Push to CRM ───────────────────────────────────────
app.post('/api/leads/:id/push-crm', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE leads SET status='pushed-to-crm',pushed_to_crm_at=$1 WHERE id=$2 RETURNING *`,
    [new Date().toISOString(), req.params.id]
  );
  // TODO: Tekion APC API call goes here when credentials are available
  res.json({ ok: true, lead: rows[0] });
});

// ── Stats ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at::date=$1::date AND is_test=false) AS intercepted_today,
      COUNT(*) FILTER (WHERE status='contacted' AND created_at::date=$1::date AND is_test=false) AS contacted_today,
      COUNT(*) FILTER (WHERE status='pushed-to-crm' AND created_at::date=$1::date AND is_test=false) AS crm_today,
      COUNT(*) FILTER (WHERE status='passed-through' AND created_at::date=$1::date AND is_test=false) AS passed_today
    FROM leads`, [today]
  );
  res.json(rows[0]);
});

// ── Reports ───────────────────────────────────────────
app.get('/api/reports', async (req, res) => {
  const days = parseInt(req.query.days || 30);
  const since = new Date(Date.now() - days*24*60*60*1000).toISOString();
  const [src, daily, status] = await Promise.all([
    pool.query(`
      SELECT source,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('contacted','pushed-to-crm')) AS contacted,
        COUNT(*) FILTER (WHERE status='pushed-to-crm') AS pushed_to_crm,
        COUNT(*) FILTER (WHERE status IN ('intercepted','ai-engaged')) AS no_response,
        ROUND(100.0*COUNT(*) FILTER (WHERE status IN ('contacted','pushed-to-crm'))/NULLIF(COUNT(*),0),1) AS contact_rate
      FROM leads WHERE created_at>=$1 AND is_test=false
      GROUP BY source ORDER BY total DESC`, [since]),
    pool.query(`
      SELECT created_at::date AS date, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('contacted','pushed-to-crm')) AS contacted
      FROM leads WHERE created_at>=$1 AND is_test=false
      GROUP BY created_at::date ORDER BY date DESC`, [since]),
    pool.query(`
      SELECT status, COUNT(*) AS count FROM leads
      WHERE created_at>=$1 AND is_test=false GROUP BY status ORDER BY count DESC`, [since])
  ]);
  res.json({ by_source: src.rows, daily: daily.rows, by_status: status.rows, period_days: days });
});

// ── Routes ────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'marketing.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Prelude AI on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
