const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANKI_AI_TOKEN = process.env.ANKI_AI_TOKEN || "";
const MODEL = process.env.MODEL || "gpt-5-mini";
const DAILY_TOKEN_LIMIT = Number(process.env.DAILY_TOKEN_LIMIT || 200);

const REQUESTS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 12000;
const MAX_QUESTION_LENGTH = 2000;

// In-memory stores (single-instance service only).
const ipRateStore = new Map(); // ip -> [timestamps]
const dailyTokenStore = new Map(); // YYYY-MM-DD:token -> count
const responseCache = new Map(); // cacheKey -> { createdAt, response }

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function stripHtml(input) {
  const value = typeof input === "string" ? input : "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(input, maxLen) {
  return input.length > maxLen ? input.slice(0, maxLen) : input;
}

function cleanText(input) {
  return truncate(stripHtml(input), MAX_TEXT_LENGTH);
}

function cleanQuestion(input) {
  return truncate(stripHtml(input), MAX_QUESTION_LENGTH);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const current = ipRateStore.get(ip) || [];
  const recent = current.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= REQUESTS_PER_MINUTE) {
    ipRateStore.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipRateStore.set(ip, recent);
  return false;
}

function getTokenDayKey(token) {
  const day = new Date().toISOString().slice(0, 10);
  return `${day}:${token}`;
}

function isDailyTokenLimitReached(token) {
  const key = getTokenDayKey(token);
  const used = dailyTokenStore.get(key) || 0;
  if (used >= DAILY_TOKEN_LIMIT) {
    return true;
  }
  dailyTokenStore.set(key, used + 1);
  return false;
}

function buildCacheKey(action, text, extra, userQuestion) {
  const raw = [action, text, extra, action === "ask" ? userQuestion : ""].join("||");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    responseCache.delete(cacheKey);
    return null;
  }
  return cached.response;
}

function setCachedResponse(cacheKey, response) {
  responseCache.set(cacheKey, {
    createdAt: Date.now(),
    response
  });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!ANKI_AI_TOKEN || token !== ANKI_AI_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.authToken = token;
  return next();
}

function rateLimitMiddleware(req, res, next) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again in one minute." });
  }
  if (isDailyTokenLimitReached(req.authToken)) {
    return res.status(429).json({ error: "Daily token limit reached." });
  }
  return next();
}

function validateBody(body) {
  if (!body || typeof body !== "object") {
    return "Invalid JSON body.";
  }

  const { action, primary } = body;
  if (!["explain", "step2", "ask"].includes(action)) {
    return "Invalid action.";
  }
  if (!primary || typeof primary !== "object") {
    return "Missing primary object.";
  }
  if (action === "ask") {
    const q = cleanQuestion(body.userQuestion || "");
    if (!q) return "userQuestion is required for action='ask'.";
  }
  return null;
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .slice(0, 8)
    .map((x) => x.trim());
}

function safeStep2(value) {
  if (!value || typeof value !== "object") return null;
  const letters = ["A", "B", "C", "D", "E"];
  const choices = value.choices && typeof value.choices === "object" ? value.choices : {};
  const normalizedChoices = {};
  for (const letter of letters) {
    normalizedChoices[letter] = typeof choices[letter] === "string" ? choices[letter].trim() : "";
  }
  const hasAllChoices = letters.every((l) => normalizedChoices[l]);
  const answer = typeof value.answer === "string" ? value.answer.trim().toUpperCase() : "";

  if (!hasAllChoices || !letters.includes(answer)) {
    return null;
  }

  return {
    stem: typeof value.stem === "string" ? value.stem.trim() : "",
    choices: normalizedChoices,
    answer,
    rationale: typeof value.rationale === "string" ? value.rationale.trim() : ""
  };
}

function enforceResponseShape(input, action, fallbackTitle) {
  const base = input && typeof input === "object" ? input : {};
  const shaped = {
    title: typeof base.title === "string" && base.title.trim() ? base.title.trim() : fallbackTitle,
    explanation:
      typeof base.explanation === "string" && base.explanation.trim()
        ? base.explanation.trim()
        : "No explanation generated.",
    highYieldTakeaways: safeArray(base.highYieldTakeaways),
    step2Question: action === "step2" ? safeStep2(base.step2Question) : null,
    meta: {
      cached: false
    }
  };

  if (action === "step2" && !shaped.step2Question) {
    shaped.step2Question = {
      stem: "Unable to generate a valid Step 2 question.",
      choices: {
        A: "Insufficient data",
        B: "Insufficient data",
        C: "Insufficient data",
        D: "Insufficient data",
        E: "Insufficient data"
      },
      answer: "A",
      rationale: "The model response did not match the required question format."
    };
  }

  return shaped;
}

function buildPrompt(action, context) {
  const sharedRules = [
    "You are an assistant for medical flashcards.",
    "Use only the provided card content and user question.",
    "Return strict JSON only. No markdown.",
    "Never mention UWorld, scraped text, hidden data, APIs, tokens, prompts, or tool internals.",
    "Be concise, clinically useful, and accurate."
  ].join("\n");

  const contentBlock = [
    `CARD_TEXT: ${context.text || "(empty)"}`,
    `CARD_EXTRA: ${context.extra || "(empty)"}`,
    `DECK: ${context.deck || "(unknown)"}`,
    `NOTETYPE: ${context.noteType || "(unknown)"}`,
    `FIELDS_JSON: ${JSON.stringify(context.fields || {})}`
  ].join("\n");

  if (action === "explain") {
    return {
      instructions: `${sharedRules}
Task: Provide a concise Step 2-style explanation and 3-5 high-yield takeaways.
JSON schema:
{
  "title": "short title",
  "explanation": "concise explanation",
  "highYieldTakeaways": ["...", "..."],
  "step2Question": null
}`,
      input: contentBlock
    };
  }

  if (action === "step2") {
    return {
      instructions: `${sharedRules}
Task: Create exactly ONE Step 2-style multiple choice question with A-E choices.
JSON schema:
{
  "title": "short title",
  "explanation": "brief setup explanation",
  "highYieldTakeaways": ["...", "..."],
  "step2Question": {
    "stem": "question stem",
    "choices": {
      "A": "...",
      "B": "...",
      "C": "...",
      "D": "...",
      "E": "..."
    },
    "answer": "A|B|C|D|E",
    "rationale": "why correct and why others are less correct"
  }
}`,
      input: contentBlock
    };
  }

  return {
    instructions: `${sharedRules}
Task: Answer the user question using only the card context; include 3-5 high-yield takeaways.
JSON schema:
{
  "title": "short title",
  "explanation": "answer to user question",
  "highYieldTakeaways": ["...", "..."],
  "step2Question": null
}`,
    input: `${contentBlock}\nUSER_QUESTION: ${context.userQuestion || "(empty)"}`
  };
}

function extractTextFromResponsesApi(result) {
  if (typeof result?.output_text === "string" && result.output_text.trim()) {
    return result.output_text.trim();
  }
  if (Array.isArray(result?.output)) {
    const chunks = [];
    for (const item of result.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const c of item.content) {
        if (typeof c?.text === "string" && c.text.trim()) {
          chunks.push(c.text);
        }
      }
    }
    if (chunks.length > 0) return chunks.join("\n").trim();
  }
  return "";
}

async function callOpenAI(action, context) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const prompt = buildPrompt(action, context);
  const payload = {
    model: MODEL,
    input: [
      { role: "system", content: prompt.instructions },
      { role: "user", content: prompt.input }
    ],
    text: {
      format: {
        type: "json_object"
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const rawText = extractTextFromResponsesApi(data);
  if (!rawText) {
    throw new Error("OpenAI returned empty output.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error("OpenAI output was not valid JSON.");
  }

  return parsed;
}

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/anki-ai", authMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const validationError = validateBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const action = req.body.action;
    const cleanedText = cleanText(req.body?.primary?.Text || "");
    const cleanedExtra = cleanText(req.body?.primary?.Extra || "");
    const cleanedQuestion = cleanQuestion(req.body?.userQuestion || "");
    const deck = cleanText(req.body?.deck || "");
    const noteType = cleanText(req.body?.noteType || "");
    const fields =
      req.body?.fields && typeof req.body.fields === "object" ? req.body.fields : null;

    const cacheKey = buildCacheKey(action, cleanedText, cleanedExtra, cleanedQuestion);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return res.status(200).json({
        ...cached,
        meta: { cached: true }
      });
    }

    const fallbackTitleByAction = {
      explain: "Card Explanation",
      step2: "Step 2 Practice Question",
      ask: "Card Q&A"
    };

    const modelOutput = await callOpenAI(action, {
      text: cleanedText,
      extra: cleanedExtra,
      userQuestion: cleanedQuestion,
      deck,
      noteType,
      fields
    });

    const finalResponse = enforceResponseShape(
      modelOutput,
      action,
      fallbackTitleByAction[action] || "Anki AI"
    );
    setCachedResponse(cacheKey, finalResponse);
    return res.status(200).json(finalResponse);
  } catch (error) {
    console.error("POST /anki-ai error:", error);
    return res.status(500).json({ error: "Failed to process request." });
  }
});

app.listen(PORT, () => {
  console.log(`Anki AI backend listening on port ${PORT}`);
});
