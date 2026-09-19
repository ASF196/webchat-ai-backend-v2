// lib/answerEngine.js
// The actual "ask the model" logic, shared by:
//   - routes/chat.js        (public widget — real visitors)
//   (Quality Testing was removed; this stays shared so any future caller
//    gets the exact same answer a real visitor would.)
// Keeping this in one place means a quality test result reflects EXACTLY what
// a real visitor would see, using the same prompt, same model, same parsing.

const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-20b';

const UNSURE = ['not in the content','not found',"don't have",'not mention','cannot find','no information',"doesn't mention","isn't covered",'not available','not provided',"can't find",'unable to find','not specified','not stated','not included',"i don't see",'not listed',"doesn't say","doesn't cover",'not described','no details',"i cannot answer",'not enough information','unclear from',"doesn't provide"];
function isUnsure(t) {
  const lower = t.toLowerCase();
  return UNSURE.some(p => lower.includes(p));
}

function parseSuggestions(raw) {
  const m = raw.match(/\|{2,4}\s*SUGS\s*\|{2,4}/);
  if (!m) return { text: raw.trim(), suggestions: [] };
  const idx = m.index;
  const text = raw.slice(0, idx).trim();
  let jsonPart = raw.slice(idx + m[0].length).trim();
  const start = jsonPart.indexOf('[');
  const end = jsonPart.lastIndexOf(']');
  if (start !== -1 && end > start) jsonPart = jsonPart.slice(start, end + 1);
  try {
    const arr = JSON.parse(jsonPart);
    if (Array.isArray(arr)) {
      return { text, suggestions: arr.filter(s => typeof s === 'string').slice(0, 3) };
    }
  } catch {
    // model didn't return valid JSON for suggestions — just drop the marker
  }
  return { text, suggestions: [] };
}

const SYSTEM_PROMPT = (siteName, kb, pageContext) => `You are a helpful, knowledgeable assistant for "${siteName}". You have been trained on the site's full content below.
${pageContext ? `\nThe visitor is CURRENTLY LOOKING AT this page — if they ask something ambiguous like "which one is better" or "what's the difference", they very likely mean what's described here:\n${pageContext}\n` : ''}
RULES:
- Answer from the provided content. If the answer IS in the content, give it — never say you "can't find" or "don't have" info that is actually present.
- Security, compliance, pricing, features: quote the exact text from the content verbatim.
- Keep answers concise: 3-6 sentences. Use bullet points for lists.
- Use **bold** for one key term only.
- Never reply with [object], JSON syntax, or raw data structures.
- Only say "I don't have that info" for topics genuinely absent from the knowledge base.
- If asked about security/privacy/compliance/certifications, look for that info in the content and answer it directly.

RESPONSE FORMAT — always end every reply with this exact block (no exceptions):
|||SUGS|||["short follow-up 1","short follow-up 2","short follow-up 3"]

The 3 suggestions must be under 6 words each, relevant to the conversation, and be questions the person would naturally ask next. Keep them as a valid JSON array on one line after |||SUGS|||.

SITE KNOWLEDGE BASE:
${kb}`;

// bot: a row from the `bots` table. message: the question. history: prior
// turns (optional, [] for a one-off quality test). pageContext: optional.
async function generateAnswer(bot, message, history = [], pageContext = null) {
  const safePageContext = typeof pageContext === 'string' ? pageContext.slice(0, 900) : null;

  // The agency's curated/crawled training and anything the client added
  // themselves are stored separately (so neither can clobber the other),
  // but the model should see them as one body of knowledge. Client-added
  // notes go last so that when the two disagree, the client's own more
  // recent correction is the thing the model read most recently.
  const fullKnowledge = [
    bot.knowledge_base || '',
    bot.custom_notes ? `\n\n--- ADDITIONAL INFORMATION FROM THE BUSINESS ---\n${bot.custom_notes}` : '',
  ].join('');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(bot.site_name || bot.name, fullKnowledge, safePageContext) },
    ...history.slice(-4),
    { role: 'user', content: message }
  ];

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 450, temperature: 0.4 })
  });

  if (!groqRes.ok) {
    const errBody = await groqRes.text();
    console.error('Groq error:', groqRes.status, errBody);
    const err = new Error('Upstream AI provider error');
    err.upstream = true;
    throw err;
  }

  const data = await groqRes.json();
  const raw = data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
  const { text, suggestions } = parseSuggestions(raw);
  return { reply: text, suggestions, unsure: isUnsure(text) };
}

module.exports = { generateAnswer, isUnsure, parseSuggestions };
