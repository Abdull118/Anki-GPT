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

const STEP2_REFERENCE_EXAMPLES = `Reference examples for style only (do not copy wording, exact details, or answers):

Example 1
A 65-year-old woman comes to the hospital due to vague left flank pain, fatigue, and sweats for 12 days. For the past 2 days she has also had fever and nausea. The patient was treated with oral antibiotics for a urinary tract infection 4 weeks ago and has had no dysuria since, but she has lost 2.3 kg (5 lb) in the interim. Other medical conditions include type 2 diabetes mellitus and hypertension. The patient smokes a pack of cigarettes daily and uses alcohol occasionally. Temperature is 38.7 C (101.7 F), blood pressure is 130/80 mm Hg, pulse is 94/min, and respirations are 16/min. Cardiopulmonary examination is normal. Marked left flank tenderness is present. Laboratory results are as follows:

Complete blood count
Hemoglobin 10.8 g/dL
Leukocytes 14,000/mm3
Platelets 340,000/mm3
Serum chemistry
Blood urea nitrogen 32 mg/dL
Creatinine 1.6 mg/dL
Glucose 355 mg/dL
Urinalysis
White blood cells 2-5/hpf
Red blood cells 1-2/hpf
Bacteria none

Which of the following is the most likely diagnosis?
A. Acute interstitial nephritis
B. Papillary necrosis
C. Renal abscess
D. Renal cell carcinoma
E. Renal tuberculosis

Example 2
A 35 year-old man comes to the office after a year of weakness, fatigue, and weight loss. He has experienced reduced appetite and intermittent diarrhea. The patient had no improvement after several sessions with a clinical psychologist, who suggested evaluation for a physiological cause of his symptoms. His medical history is unremarkable, and he takes no regularly scheduled medications. The patient does not use tobacco, alcohol, or illicit drugs. Family history is notable for hypothyroidism (sister). Temperature is 37.2 C (99 F), blood pressure is 106/66 mm Hg, pulse is 94/min, and respirations are 14/min. On physical examination, the patient does not appear to be in acute distress. His neck shows no thyromegaly or lymphadenopathy. Cardiopulmonary examination is normal, and the abdomen is soft with normal bowel sounds and no organomegaly. Motor strength and deep tendon reflexes are normal and symmetric. Laboratory results are as follows:

Hemoglobin 12.3 g/dL
Leukocytes 4,700/mm3
Sodium 130 mEq/L
Potassium 5.5 mEq/L
8 AM cortisol 7.2 mcg/dL (normal: 5-23 mcg/dL)
TSH 2.5 mIU/L

Which of the following is the most appropriate next step in management of this patient?
A. 24-hour urine free cortisol (20%)
B. ACTH stimulation test (52%)
C. Insulin-induced hypoglycemia test (5%)
D. Intravenous hydrocortisone (6%)
E. Low-dose overnight dexamethasone suppression test

Example 3
A 16-year-old girl is brought to clinic for vision follow-up. The patient has myopia that was diagnosed at age 8. She wears corrective lenses, and her prescription has progressed yearly. The patient has no other chronic medical conditions and takes no daily medications. Vital signs are normal. Examination shows equal pupillary reflexes. Visual acuity is 20/50 bilaterally with current lenses. Refraction testing results in a lens prescription of -9 diopters sphere in the right eye and -8.75 diopters sphere in the left eye. This patient is at increased risk for which of the following complications?
A. Anterior chamber hemorrhage (4%)
B. Anterior uveitis (8%)
C. Pterygium development (22%)
D. Retinal detachment (58%)
E. Retinal microinfarctions (6%)

Example 4
A 37-year-old woman comes to the emergency department due to 5 days of fever, chills, malaise, headache, and fatigue. The patient's temperature has fluctuated between 37 C (98.6 F) and 41 C (105.8 F). She has been taking ibuprofen, which improves the fever. The patient took a 7-day vacation to Southeast Asia a month ago. Temperature is 39.9 C (103.8 F), blood pressure is 110/66 mm Hg, pulse is 112/min, and respirations are 20/min. On physical examination, the patient appears tired and has mild scleral icterus. There are no oropharyngeal lesions, lymphadenopathy, or rash. The lungs are clear on auscultation and no cardiac murmurs are present. The liver is slightly tender to palpation, and the spleen tip is palpable below the left costal margin. Neurologic examination shows no signs of meningeal irritation. Which of the following is the best next step in diagnosis of this patient?
A. Blood cultures (6%)
B. Blood smear (66%)
C. HIV antibody test (0%)
D. Serum antibody titer for Entamoeba histolytica (3%)
E. Serum antibody titer for hepatitis A (21%)

Example 5
A 22-year-old man comes to the office due to difficulty concentrating and sleeping. The patient lost his job and moved in with his parents 2 months ago. Although he has been looking for work and revising his resume, he gets distracted and easily loses focus. The patient has not received any interview invitations and is worried that he will be living with his parents for a long time. He feels that he has "reverted to my high school self," playing video games most evenings and going out with friends on the weekends. The patient gets annoyed with his parents occasionally but states that he knows they are "just trying to be helpful." He has been eating more than usual since moving, gaining 3 kg (6.6 lb) and feeling tired during the day. The patient takes 2-3 hours to fall asleep each night and frequently checks the time while in bed. He drinks 3 or 4 beers a week and does not use recreational substances. Vital signs are within normal limits. Physical examination shows no abnormalities. The patient states that his mood is "okay," and he has a full range of affect. He reports no suicidal ideation. In addition to recommending psychotherapy, which of the following is the most appropriate pharmacotherapy for this patient?
A. Alprazolam (8%)
B. Lithium (1%)
C. Methylphenidate (26%)
D. Quetiapine (7%)
E. Zolpidem (55%)

Use these as examples of vignette depth, realistic distractors, and clinically relevant lead-ins.`;

function buildPrompt(action, context) {
  const sharedRules = [
    "You are an assistant for medical flashcards.",
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
      instructions: `You are an expert medical tutor assisting a student with USMLE Step 2 CK flashcards.

### RULES
1. Grounding: Base your response ONLY on the provided card content and the user's question. Do not hallucinate outside information unless strictly necessary to clarify the user's specific point.
2. Format Requirement: You must return ONLY raw, valid JSON. Absolutely NO markdown formatting, NO markdown code blocks (do not use \`\`\`json), and NO conversational filler before or after the JSON.
3. Strict Constraints: NEVER mention UWorld, scraped text, hidden data, APIs, tokens, prompts, or internal tool workings.
4. Clinical Focus: Be concise, highly accurate, and focus on Step 2 CK principles (e.g., clinical presentation, next best step in management, gold standard diagnosis).

### TASK
Analyze the card content and user question. Output your response strictly matching this JSON schema:

{
  "title": "<A concise, 3-5 word clinical title>",
  "explanation": "<A 2-3 sentence Step 2-style explanation addressing the user's question. Focus heavily on the 'why' and the clinical mechanism.>",
  "highYieldTakeaways": [
    "<High-yield fact 1: e.g., Next best step / Best initial test>",
    "<High-yield fact 2: e.g., Key distinguishing symptom / Pathognomonic finding>",
    "<High-yield fact 3: e.g., Most common complication / Contraindication>"
  ],
  "step2Question": "<If the user asks for a practice question, provide a short, 1-2 sentence clinical vignette testing this concept here. Otherwise, return null.>"
}`,
      input: `${contentBlock}\nUSER_QUESTION: ${context.userQuestion || "(empty)"}`
    };
  }

  if (action === "step2") {
    return {
      instructions: `${sharedRules}
Task: Create exactly ONE UWorld-style Step 2 CK practice question based ONLY on the card content.

UWorld/Step2 format requirements:
- Start with a realistic clinical vignette: age/sex + setting + key symptoms + pertinent positives/negatives.
- Include focused exam findings and 1–2 key labs/imaging ONLY if they would realistically be available at that moment.
- Ask a single clear lead-in question (prefer "best next step" / management when appropriate; otherwise diagnosis).
- All answer choices A–E must be in the SAME CATEGORY (all diagnoses OR all next steps OR all tests OR all treatments).
- Exactly ONE best answer.
- Do NOT be Step 1 basic-science heavy; prioritize clinical reasoning and management.
- Avoid obscure zebras unless the card is explicitly about one.

${STEP2_REFERENCE_EXAMPLES}

Rationale requirements:
- Explain why the correct answer is correct (1–3 sentences).
- Then briefly explain why EACH wrong option is wrong (one short line per option, labeled A–E).
- Keep it concise and high-yield.

JSON schema (strict, no markdown):
{
  "title": "short title",
  "explanation": "1-3 sentence setup tying the question to the card concept",
  "highYieldTakeaways": ["3-5 concise bullets"],
  "step2Question": {
    "stem": "vignette + lead-in question",
    "choices": {
      "A": "...",
      "B": "...",
      "C": "...",
      "D": "...",
      "E": "..."
    },
    "answer": "A|B|C|D|E",
    "rationale": "Correct: <why>\\nA: <why wrong>\\nB: <why wrong>\\nC: <why wrong>\\nD: <why wrong>\\nE: <why wrong>"
  }
}`,
      input: contentBlock
    };
  }

  return {
    instructions: `${sharedRules}

    ### SPECIFIC TASK: CUSTOM Q&A
    The user has submitted a specific question regarding this flashcard. 
    1. Direct Answer: Answer their exact question clearly and concisely.
    2. Grounding: Rely heavily on the provided card context to answer the question, but you may use your clinical knowledge base to clarify the specific mechanism or 'why' behind the user's query.
    3. High-Yield Focus: Extract 3-5 high-yield takeaways specifically related to the topic of their question.
    
    ### OUTPUT FORMAT
    Return your response matching this exact JSON schema:
    {
      "title": "<A 3-5 word clinical title summarizing the topic of the user's question>",
      "explanation": "<A direct, Step 2-focused answer to the user's specific question. Keep it to 2-4 sentences and prioritize clinical reasoning.>",
      "highYieldTakeaways": [
        "<High-yield fact 1 directly relevant to the user's question (e.g., mechanism, next best step, or contraindication)>",
        "<High-yield fact 2 relevant to the question>",
        "<High-yield fact 3 relevant to the question>"
      ],
      "step2Question": "<If the user explicitly asks for a practice question in their input, write a short, 1-2 sentence clinical vignette here. Otherwise, strictly return null.>"
    }`
,    input: `${contentBlock}\nUSER_QUESTION: ${context.userQuestion || "(empty)"}`
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
