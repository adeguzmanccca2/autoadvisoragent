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

  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  const fullName = (body.fullName || '').toString().trim();
  const role = (body.role || '').toString().trim();
  const organizationId = (body.organizationId || '').toString().trim();

  if (!email || !password || !role) {
    res.status(400).json({ error: 'Missing email, password, or role' });
    return;
  }
  if (!['admin', 'dealer_owner', 'dealer_user'].includes(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (role !== 'admin' && !organizationId) {
    res.status(400).json({ error: 'organizationId required for dealer roles' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const token = extractBearer(req);
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const callerCheck = await verifyAdminCaller(token, admin);
  if (callerCheck.error) { res.status(callerCheck.status).json({ error: callerCheck.error }); return; }

  try {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { full_name: fullName }
    });
    if (createErr) throw createErr;
    const userId = created && created.user && created.user.id;
    if (!userId) throw new Error('User creation returned no id');

    const profileRow = {
      id: userId,
      email: email,
      full_name: fullName || null,
      role: role,
      organization_id: role === 'admin' ? null : organizationId
    };

    const { error: profileErr } = await admin.from('profiles').insert(profileRow);
    if (profileErr) {
      // roll back auth user so we don't leave an orphan
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      throw profileErr;
    }

    res.status(200).json({
      ok: true,
      user: { id: userId, email: email, full_name: fullName, role: role, organization_id: profileRow.organization_id }
    });
  } catch (err) {
    console.error('[admin-create-user]', err && (err.stack || err.message || err));
    res.status(500).json({ error: err.message || 'Failed to create user' });
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
    return { ok: true };
  } catch (e) {
    return { status: 500, error: e.message || 'Auth verification failed' };
  }
}
