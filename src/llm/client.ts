import '../config/load.js'; // ensures .env is loaded before any process.env read below

/**
 * Shared LLM client — the one place in the codebase that talks to an LLM API.
 *
 * Rotates across up to three Groq keys (GROQ_API_KEY, GROQ_API_KEY_2,
 * GROQ_API_KEY_3) on auth/rate-limit/server errors, then falls back to Gemini
 * (GEMINI_API_KEY) if every Groq key is exhausted. Any feature that needs an
 * LLM call (doc-intelligence's AI Summary today, others later) should import
 * `chatComplete` from here rather than adding its own provider code — that
 * was the whole point of pulling this out of the doc-intelligence layer.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider to constrain output to a single JSON object/array. */
  jsonMode?: boolean;
}

// Overridable via .env — provider model ids get retired regularly, and that
// should be a config change rather than a code change.
const groqModel = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_ENDPOINT = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${key}`;

interface HttpError extends Error {
  status?: number;
}

function groqKeys(): string[] {
  return [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(
    (k): k is string => !!k && k.trim().length > 0,
  );
}

function geminiKey(): string | undefined {
  const k = process.env.GEMINI_API_KEY;
  return k && k.trim().length > 0 ? k : undefined;
}

/** Errors worth rotating to the next key/provider for, rather than failing outright. */
function isRotatable(err: unknown): boolean {
  const status = (err as HttpError).status;
  return status === 401 || status === 403 || status === 429 || (typeof status === 'number' && status >= 500);
}

async function callGroq(key: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: groqModel(),
      messages,
      temperature: opts.temperature ?? 0.2,
      // Groq's gpt-oss models are reasoning models: reasoning tokens are drawn
      // from this same budget before any content is emitted, so a tight cap
      // yields an empty `content`. Keep the budget generous and the reasoning
      // effort low — this is summarisation over facts already established.
      max_tokens: opts.maxTokens ?? 4000,
      reasoning_effort: 'low',
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: HttpError = new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Groq returned empty content');
  return content;
}

async function callGemini(key: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const system = messages.find((m) => m.role === 'system')?.content;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const res = await fetch(GEMINI_ENDPOINT(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? 4000,
        ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: HttpError = new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new Error('Gemini returned empty content');
  return content;
}

/**
 * Sends a chat completion, rotating across every configured Groq key on
 * auth/rate-limit/server errors, then falling back to Gemini. Throws only
 * once every configured provider/key has failed (or none are configured).
 */
export async function chatComplete(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const attempts: string[] = [];
  const keys = groqKeys();

  for (const [i, key] of keys.entries()) {
    try {
      return await callGroq(key, messages, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push(`groq#${i + 1}: ${message}`);
      if (!isRotatable(err)) break;
    }
  }

  const gKey = geminiKey();
  if (gKey) {
    try {
      return await callGemini(gKey, messages, opts);
    } catch (err) {
      attempts.push(`gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (attempts.length === 0) {
    throw new Error(
      'No LLM API keys configured. Set GROQ_API_KEY (optionally _2/_3) and/or GEMINI_API_KEY in .env.',
    );
  }
  throw new Error(`All LLM providers failed: ${attempts.join(' | ')}`);
}

/** True when at least one provider key is configured, without making a call. */
export function llmConfigured(): boolean {
  return groqKeys().length > 0 || geminiKey() !== undefined;
}
