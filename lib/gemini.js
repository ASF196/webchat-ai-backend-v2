// lib/gemini.js
// Server-side call to Gemini — used only by the "Train AI" refinement step
// (routes/scrape.js: POST /refine). Turns raw scraped/extracted page text
// into clean, structured knowledge-base notes.
//
// This key lives ONLY here, read from process.env.GEMINI_API_KEY, and is
// never sent to or embedded in the browser. (An earlier, now-retired
// version of this feature called Gemini directly from client-side JS with
// a hardcoded key — that's exactly the mistake this file exists to avoid.)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.6-flash';

// This is a straight, server-side port of the prompt from the old
// client-side "refineWithGemini" function — kept because it already
// produces good structured knowledge-base output (exhaustive fact
// preservation, generated FAQ pairs, verbatim security/compliance text).
// Only the delivery mechanism changed: this now runs on the server with
// the key in an env var, instead of in the browser with the key baked
// into the page source.
function buildRefinePrompt(rawText, sourceUrl) {
  return `You are a knowledge extraction expert preparing training data for a customer support AI chatbot. I'm giving you raw scraped text from a website page. Your job is to extract and preserve EVERY piece of useful information — nothing should be missed.

CRITICAL RULES:
1. NEVER omit any facts, figures, certifications, features, or claims — even if they seem minor
2. Copy exact phrases for: prices, certifications, compliance info, security claims, guarantees, SLAs, limits, dates
3. Security/compliance info (SOC 2, GDPR, HIPAA, ISO, encryption, data policies) MUST be fully preserved verbatim
4. Every feature, plan tier, pricing number must appear exactly as stated
5. FAQs: generate Q&A pairs covering EVERY topic present in the content — security, pricing, features, how it works, integrations, limits, refunds, support
6. Do NOT summarize security/legal/compliance sections — copy them word-for-word
7. Remove only: navigation menus, cookie notices, social share buttons, duplicate content

Output format (only include sections with content):

# OVERVIEW
[What the product/site is, core value proposition, who it's for]

# FEATURES
[Every feature, capability, integration — use bullet points, be exhaustive]

# PRICING & PLANS
[Every plan name, price, billing period, what's included/excluded — exact numbers]

# SECURITY & COMPLIANCE
[Copy ALL security/compliance text verbatim — certifications, encryption, data policies, privacy commitments]

# HOW IT WORKS
[Setup steps, workflows, processes]

# INTEGRATIONS & COMPATIBILITY
[Every integration, supported platform, API info]

# LIMITS & SPECIFICATIONS
[Message limits, user limits, storage, token limits, etc]

# FAQ
[Generate 15-25 Q&A pairs covering every topic a user might ask about — include questions about security, pricing, features, how-to, support, data, cancellation, etc]

# SUPPORT & CONTACT
[Support channels, response times, contact info]

# OTHER KEY FACTS
[Any remaining important info — stats, guarantees, awards, testimonials]

Source: ${sourceUrl || 'unknown'}

RAW CONTENT (extract everything useful):
${rawText}`;
}

// Refines rawText (already stripped of HTML tags) into clean knowledge-base
// notes. Resolves with the refined string, or throws — callers should catch
// this and fall back to the raw text rather than blocking the import,
// since a training import shouldn't fail just because Gemini had a bad moment.
async function refineForKnowledgeBase(rawText, sourceUrl) {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini is not configured on the server (GEMINI_API_KEY missing)');
  }
  const trimmed = String(rawText || '').trim().slice(0, 20000); // matches the original prompt's cap
  if (!trimmed) throw new Error('No text to refine');

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildRefinePrompt(trimmed, sourceUrl) }] }],
        // temperature omitted — Gemini 3-family models deprecate it (see
        // the note on the same param in answerAsFallback below).
        generationConfig: { maxOutputTokens: 8192 },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gemini request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.length < 200) throw new Error('Empty or too-short response from Gemini');
  return text.trim();
}

// ── Fallback answering (used only when Groq itself fails/rate-limits) ──
// This is a genuinely different thing from the "20 Groq accounts" idea
// that got ruled out earlier: that was multiple accounts on the SAME
// provider specifically to dodge its own limit, which Groq's Acceptable
// Use Policy explicitly forbids. This is your existing, single, legitimate
// Gemini account — already used for KB refinement — stepping in for a few
// seconds while Groq recovers from a 429. Two different providers, two
// real accounts, ordinary multi-provider resilience.
//
// Reuses answerEngine.js's own SYSTEM_PROMPT builder and message history —
// passed in rather than rebuilt here, so the fallback answer is generated
// from the exact same instructions/knowledge a Groq answer would have used.
async function answerAsFallback(systemPrompt, history, message) {
  if (!GEMINI_API_KEY) throw new Error('Gemini is not configured on the server (GEMINI_API_KEY missing)');

  // Gemini's REST API takes the system prompt as its own field, and turns
  // as {role, parts}, with 'model' instead of OpenAI's 'assistant' — a
  // straight reshape of the same conversation, not a different prompt.
  const contents = [
    ...history.slice(-4).map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        // Gemini 3-family models (this one included) deprecate
        // temperature/top-p/top-k — omitted rather than sent-and-ignored,
        // per Google's own migration guidance for the 3.x line.
        generationConfig: { maxOutputTokens: 450 },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gemini fallback request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini fallback error ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) throw new Error('Empty response from Gemini fallback');
  return {
    text: text.trim(),
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount || 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata?.totalTokenCount || 0,
    },
  };
}

module.exports = { refineForKnowledgeBase, answerAsFallback };
