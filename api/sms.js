const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const SYSTEM_PROMPT = `You are AutoAdvisor, an honest car-buying assistant texting customers over SMS. Keep replies short and conversational. Use line breaks and sparing emojis. Be honest about pricing, total cost of ownership, fuel costs, and tradeoffs. Never be pushy. If the customer wants a test drive, ask for their name and a good time.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const from = req.body.From;
  const body = req.body.Body?.trim();
  console.log(`SMS from ${from}: ${body}`);

  try {
    const conversation = await getOrCreateConversation(from, 'sms');
    await saveMessage(conversation.id, 'customer', body);
    const history = await getHistory(conversation.id);
    const { data: inventory } = await supabase.from('inventory').select('*').limit(20);

    const messages = history.map(m => ({
      role: m.role === 'customer' ? 'user' : 'assistant',
      content: m.content
    }));

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT + (inventory?.length ? `\n\nInventory:\n${JSON.stringify(inventory)}` : ''),
      messages
    });

    const reply = response.content.map(b => b.text || '').join('');
    await saveMessage(conversation.id, 'ai', reply);

    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
      body: reply
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error('ERROR:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
}

async function getOrCreateConversation(customerPhone, channel) {
  const { data: existing } = await supabase
    .from('conversations').select('*')
    .eq('customer_phone', customerPhone)
    .eq('channel', channel)
    .order('created_at', { ascending: false })
    .limit(1).single();

  if (existing) {
    await supabase.from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  const { data: newConv } = await supabase.from('conversations').insert({
    customer_phone: customerPhone,
    channel,
    last_message_at: new Date().toISOString()
  }).select().single();

  return newConv;
}

async function saveMessage(conversationId, role, content) {
  await supabase.from('messages').insert({ conversation_id: conversationId, role, content });
}

async function getHistory(conversationId) {
  const { data } = await supabase.from('messages')
    .select('*').eq('conversation_id', conversationId)
    .order('created_at', { ascending: true }).limit(20);
  return data || [];
}