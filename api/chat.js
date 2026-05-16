const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const SYSTEM_PROMPT = `You are AutoAdvisor, an honest, friendly car-buying assistant embedded on a car dealership's website.

Style:
- Conversational, warm, never pushy.
- Short replies. Use line breaks for clarity. Sparing emojis.
- Be transparent about pricing, total cost of ownership, fuel costs, and tradeoffs.
- If the customer is ready to test-drive or wants to be contacted, ask for their name and phone number.
- Recommend vehicles only from the dealer's live inventory below. If nothing matches, say so honestly and suggest what's closest.
- Never invent vehicles, prices, or specs.`;

const ALLOWED_ORIGINS = '*';

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const dealerId = (body.dealerId || 'default').toString().slice(0, 64);
  const message = (body.message || '').toString().trim();
  const incomingConversationId = body.conversationId || null;
  const incomingLead = body.lead && typeof body.lead === 'object' ? body.lead : null;
  const isLeadCapture = !!body.leadCapture;
  const pageUrl = (body.pageUrl || '').toString().slice(0, 500);

  if (!message) { res.status(400).json({ error: 'Missing message' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Supabase environment variables not configured' });
    return;
  }

  try {
    const conversation = await getOrCreateConversation({
      conversationId: incomingConversationId,
      dealerId,
      phone: incomingLead && incomingLead.phone ? incomingLead.phone : null,
      pageUrl
    });

    if (!isLeadCapture) {
      await saveMessage(conversation.id, 'customer', message);
    }

    if (incomingLead && incomingLead.name && incomingLead.phone) {
      await upsertLead(conversation.id, dealerId, incomingLead, message);
    }

    if (isLeadCapture) {
      res.status(200).json({ reply: '', conversationId: conversation.id });
      return;
    }

    const history = await getHistory(conversation.id);
    const inventory = await getInventory(dealerId);

    const messages = history.map(m => ({
      role: m.role === 'customer' ? 'user' : 'assistant',
      content: m.content
    }));

    const systemPrompt = buildSystemPrompt(inventory, dealerId, pageUrl);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      system: systemPrompt,
      messages
    });

    const reply = (response.content || [])
      .map(b => (b && b.type === 'text' ? b.text : ''))
      .join('')
      .trim() || "Sorry — I didn't catch that. Could you say it another way?";

    await saveMessage(conversation.id, 'ai', reply);
    await maybeExtractLead(conversation.id, dealerId, history, message, reply);

    res.status(200).json({ reply: reply, conversationId: conversation.id });
  } catch (err) {
    console.error('[api/chat] error:', err && (err.stack || err.message || err));
    res.status(500).json({ error: 'Server error: ' + (err.message || 'unknown') });
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getOrCreateConversation({ conversationId, dealerId, phone, pageUrl }) {
  const nowIso = new Date().toISOString();

  if (conversationId) {
    const { data: existing } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .single();
    if (existing) {
      await supabase
        .from('conversations')
        .update({ last_message_at: nowIso })
        .eq('id', existing.id);
      return existing;
    }
  }

  const customerPhone = phone || ('web:' + dealerId + ':' + shortRandom());
  const insertRow = {
    customer_phone: customerPhone,
    channel: 'web',
    organization_id: dealerId,
    last_message_at: nowIso
  };

  const { data: created, error } = await supabase
    .from('conversations')
    .insert(insertRow)
    .select()
    .single();
  if (error) throw error;
  return created;
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });
  if (error) throw error;
}

async function getHistory(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role,content,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(30);
  if (error) return [];
  return data || [];
}

async function getInventory(dealerId) {
  let q = supabase.from('inventory').select('*').limit(40);
  if (dealerId && dealerId !== 'default') {
    q = q.eq('organization_id', dealerId);
  }
  const { data } = await q;
  if (data && data.length) return data;
  const fb = await supabase.from('inventory').select('*').limit(40);
  return fb.data || [];
}

function buildSystemPrompt(inventory, dealerId, pageUrl) {
  let prompt = SYSTEM_PROMPT;
  prompt += `\n\nDealer ID: ${dealerId}`;
  if (pageUrl) prompt += `\nCustomer is browsing: ${pageUrl}`;
  if (inventory && inventory.length) {
    prompt += `\n\nLive inventory (JSON):\n${JSON.stringify(inventory).slice(0, 12000)}`;
  } else {
    prompt += `\n\nNo inventory data is currently available. Be honest with the customer that you don't have live inventory and offer to take their info so a human can follow up.`;
  }
  return prompt;
}

async function upsertLead(conversationId, dealerId, leadInfo, lastMessage) {
  const payload = {
    conversation_id: conversationId,
    name: (leadInfo.name || '').toString().slice(0, 120) || null,
    phone: (leadInfo.phone || '').toString().slice(0, 40) || null,
    email: (leadInfo.email || '').toString().slice(0, 200) || null,
    vehicle_interest: leadInfo.vehicleInterest || guessVehicleInterest(lastMessage) || null,
    status: 'New'
  };

  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('conversation_id', conversationId)
    .limit(1)
    .maybeSingle();

  if (existing && existing.id) {
    await supabase.from('leads').update(payload).eq('id', existing.id);
  } else {
    await supabase.from('leads').insert(payload);
  }
}

async function maybeExtractLead(conversationId, dealerId, history, customerMessage, aiReply) {
  const { data: existing } = await supabase
    .from('leads').select('id').eq('conversation_id', conversationId).limit(1).maybeSingle();
  if (existing && existing.id) return;

  const phone = extractPhone(customerMessage);
  const email = extractEmail(customerMessage);
  if (!phone && !email) return;

  const name = extractName(customerMessage);
  await upsertLead(conversationId, dealerId, {
    name: name,
    phone: phone,
    email: email
  }, customerMessage);
}

function extractPhone(text) {
  if (!text) return null;
  const m = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return m[1].trim();
}

function extractEmail(text) {
  if (!text) return null;
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : null;
}

function extractName(text) {
  if (!text) return null;
  const m = text.match(/(?:my name is|i'?m|this is)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/i);
  return m ? m[1].trim() : null;
}

function guessVehicleInterest(text) {
  if (!text) return null;
  const words = text.toLowerCase();
  const hits = ['truck', 'suv', 'sedan', 'hybrid', 'ev', 'electric', 'crossover', 'minivan'];
  for (const w of hits) if (words.includes(w)) return w;
  return null;
}

function shortRandom() {
  return Math.random().toString(36).slice(2, 10);
}
