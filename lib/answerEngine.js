// lib/answerEngine.js
// The actual "ask the model" logic, shared by:
//   - routes/chat.js        (public widget — real visitors)
//   (Quality Testing was removed; this stays shared so any future caller
//    gets the exact same answer a real visitor would.)
// Keeping this in one place means a quality test result reflects EXACTLY what
// a real visitor would see, using the same prompt, same model, same parsing.

const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-20b';
const { answerAsFallback } = require('./gemini');

// Common English words that carry no topic signal — stripped before
// scoring so "what is the price" doesn't match every paragraph in the KB
// just because they all contain "the" and "is".
const STOPWORDS = new Set(['a','an','and','are','as','at','be','but','by','can','do','does','for','from','had','has','have','how','i','if','in','into','is','it','its','me','my','of','on','or','our','so','than','that','the','their','there','these','they','this','to','was','we','what','when','where','which','who','why','will','with','you','your']);

function keywordsOf(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    // Crude prefix stemming (not a real stemmer, just "first 4 chars") so
    // "price"/"prices"/"pricing" or "secure"/"security" score as the same
    // topic instead of missing each other over plurals/suffixes. False
    // positives here just mean an extra section gets included — cheap.
    // False negatives mean the actually-relevant section gets dropped —
    // expensive. Biasing toward over-matching is the safer failure mode.
    .map(w => w.length > 4 ? w.slice(0, 4) : w);
}

// Sends only the KB sections actually relevant to this question instead of
// the whole thing every single time. Cuts per-message token cost (and
// therefore how fast a free-tier or included-usage cap gets used up)
// proportionally to how much of a client's KB any one question doesn't
// need — which for a multi-page knowledge base is usually most of it.
// maxChars caps the trimmed result; a KB already smaller than that is
// returned untouched, so small clients see no behavior change at all.
function trimKnowledgeBase(fullKnowledge, question, maxChars = 4000) {
  if (!fullKnowledge || fullKnowledge.length <= maxChars) return fullKnowledge;

  // Split on the "# SECTION" headers the Gemini refine step already
  // produces (see lib/gemini.js's buildRefinePrompt) — falls back to
  // blank-line paragraphs for older/manually-pasted knowledge bases that
  // predate that structured format.
  let blocks = fullKnowledge.split(/\n(?=#{1,3}\s)/).filter(b => b.trim());
  if (blocks.length < 2) blocks = fullKnowledge.split(/\n\s*\n/).filter(b => b.trim());
  if (blocks.length < 2) return fullKnowledge.slice(0, maxChars); // nothing to score against — just truncate

  const qWords = new Set(keywordsOf(question));
  const scored = blocks.map(block => {
    const blockWords = keywordsOf(block);
    const score = blockWords.reduce((sum, w) => sum + (qWords.has(w) ? 1 : 0), 0);
    return { block, score };
  });

  // Ties (including the all-zero case, when the question shares no
  // keywords with anything) keep the original document order rather than
  // scrambling the KB, so a no-match question still gets a sensible,
  // front-loaded chunk of content instead of a random shuffle.
  const order = new Map(blocks.map((b, i) => [b, i]));
  scored.sort((a, b) => b.score - a.score || order.get(a.block) - order.get(b.block));

  let out = '';
  for (const { block } of scored) {
    if (out.length + block.length > maxChars && out.length > 0) break;
    out += (out ? '\n\n' : '') + block;
  }
  return out || fullKnowledge.slice(0, maxChars);
}

const UNSURE = ['not in the content','not found',"don't have",'not mention','cannot find','no information',"doesn't mention","isn't covered",'not available','not provided',"can't find",'unable to find','not specified','not stated','not included',"i don't see",'not listed',"doesn't say","doesn't cover",'not described','no details',"i cannot answer",'not enough information','unclear from',"doesn't provide"];
function isUnsure(t) {
  const lower = t.toLowerCase();
  return UNSURE.some(p => lower.includes(p));
}

function parseSuggestions(raw) {
  // Matches the marker even if the model got cut off before finishing the
  // closing pipes or the JSON array — a truncated "|||SUGS" with nothing
  // after it should still disappear from what the visitor sees, not leak
  // through as raw text. This is what let a cut-off response show
  // "|||SUGS" verbatim when max_tokens left too little room to finish it.
  const m = raw.match(/\|{2,4}\s*SUGS\s*\|{0,4}/);
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
    // model didn't return valid (or complete) JSON for suggestions — drop
    // the marker and any partial JSON fragment rather than showing it
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
  const knowledgeForThisQuestion = trimKnowledgeBase(fullKnowledge, message);

  const systemPrompt = SYSTEM_PROMPT(bot.site_name || bot.name, knowledgeForThisQuestion, safePageContext);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-2), // was -4 — halves how much history-tokens compound across a fast back-and-forth
    { role: 'user', content: message }
  ];

  async function callGroq() {
    return fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 400, temperature: 0.4 }) // 450 was the original; 300 cut off longer answers before they could finish the |||SUGS||| block
    });
  }

  // Groq's own 429 body names exactly how long until its per-minute token
  // window clears (e.g. "Please try again in 6.39s") — most hits are a
  // single-digit-second window, so waiting that out and retrying once
  // resolves the large majority of cases with a real Groq answer and
  // without ever needing the Gemini fallback below. Capped at 8s so one
  // retry can't stack into a very long visitor-facing wait.
  function retryDelayMs(res, bodyText) {
    const header = res?.headers?.get('retry-after');
    if (header && !isNaN(parseFloat(header))) return Math.min(parseFloat(header) * 1000 + 300, 8000);
    const match = /try again in ([\d.]+)s/i.exec(bodyText || '');
    if (match) return Math.min(parseFloat(match[1]) * 1000 + 300, 8000);
    return 2500; // no hint given — short default wait rather than none
  }

  let groqRes, errBody = '', networkErr = null;
  try {
    groqRes = await callGroq();
    if (!groqRes.ok) errBody = await groqRes.text().catch(() => '');
  } catch (err) {
    networkErr = err;
  }

  if (groqRes && groqRes.status === 429 && !networkErr) {
    const delay = retryDelayMs(groqRes, errBody);
    console.error(`Groq 429 (rate limit) — retrying once after ${delay}ms:`, errBody);
    await new Promise(r => setTimeout(r, delay));
    try {
      groqRes = await callGroq();
      errBody = groqRes.ok ? '' : await groqRes.text().catch(() => '');
    } catch (err) {
      networkErr = err;
      groqRes = null;
    }
  }

  if (!groqRes || !groqRes.ok) {
    if (groqRes) console.error('Groq error:', groqRes.status, errBody);
    else console.error('Groq network error:', networkErr?.message);

    // Groq is almost always the one that's rate-limited or briefly down —
    // not Gemini, a completely separate provider — so try Gemini once
    // before giving up and showing the visitor an error. By this point
    // the retry above has already given Groq a second, honored-delay
    // chance, so reaching here means it's a genuinely sustained issue,
    // not just a single-minute token-window blip.
    try {
      const fallback = await answerAsFallback(systemPrompt, history, message);
      const { text, suggestions } = parseSuggestions(fallback.text);
      return { reply: text, suggestions, unsure: isUnsure(text), usage: fallback.usage };
    } catch (fallbackErr) {
      console.error('Gemini fallback also failed:', fallbackErr.message);
      const err = new Error('Upstream AI provider error');
      err.upstream = true;
      throw err;
    }
  }

  const data = await groqRes.json();
  const raw = data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
  const { text, suggestions } = parseSuggestions(raw);
  // Groq's response includes real token counts for this exact call — this is
  // what routes/chat.js records for usage tracking/limits, rather than
  // estimating token count client-side, which would drift from reality.
  const usage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };
  return { reply: text, suggestions, unsure: isUnsure(text), usage };
}

module.exports = { generateAnswer, isUnsure, parseSuggestions };
