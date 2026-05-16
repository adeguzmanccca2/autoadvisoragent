const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Supabase server env vars not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const userId = (body.userId || '').toString().trim();
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }

  const token = extractBearer(req);
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const callerCheck = await verifyAdminCaller(token, admin);
  if (callerCheck.error) { res.status(callerCheck.status).json({ error: callerCheck.error }); return; }

  if (callerCheck.callerId === userId) {
    res.status(400).json({ error: 'Cannot delete your own admin account' });
    return;
  }

  try {
    await admin.from('profiles').delete().eq('id', userId);
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) throw delErr;
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[admin-delete-user]', err && (err.stack || err.message || err));
    res.status(500).json({ error: err.message || 'Failed to delete user' });
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function extractBearer(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function verifyAdminCaller(token, admin) {
  try {
    if (!SUPABASE_ANON_KEY) return { status: 500, error: 'SUPABASE_ANON_KEY env var missing' };
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData || !userData.user) return { status: 401, error: 'Invalid auth token' };
    const callerId = userData.user.id;

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('id,role')
      .eq('id', callerId)
      .maybeSingle();
    if (profileErr) return { status: 500, error: 'Could not load caller profile' };
    if (!profile || profile.role !== 'admin') return { status: 403, error: 'Forbidden — admin only' };
    return { ok: true, callerId: callerId };
  } catch (e) {
    return { status: 500, error: e.message || 'Auth verification failed' };
  }
}
