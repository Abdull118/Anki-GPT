# Anki AI Backend (Render + Node.js)

Render-deployable Express API for an Anki card-template "AI bar" (Anki Desktop + AnkiMobile iOS).  
This is a backend service, not an Anki add-on.

## Features
- `GET /health` returns `ok`
- `POST /anki-ai` supports:
  - `explain`: concise Step 2-style explanation + takeaways
  - `step2`: one A-E Step 2 MCQ + rationale
  - `ask`: answers user free-form question grounded in card
- Bearer auth via `ANKI_AI_TOKEN`
- CORS enabled (allow all)
- JSON payload limit: `1mb`
- HTML stripping + truncation:
  - `Text`/`Extra`: max 12,000 chars
  - `userQuestion`: max 2,000 chars
- In-memory protections:
  - Per-IP: 10 requests/minute
  - Per-token daily cap: `DAILY_TOKEN_LIMIT` (default 200)
  - 24h response cache keyed by SHA-256 of cleaned inputs

## Files
- `package.json`
- `server.js`

## Render Deploy (Web Service)
1. Push these files to a GitHub repo.
2. In Render, click `New` -> `Web Service`.
3. Connect the repo.
4. Configure:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add environment variables in Render:
   - `OPENAI_API_KEY` = your OpenAI key
   - `ANKI_AI_TOKEN` = a custom token used by your Anki template
   - `MODEL` = `gpt-5-mini` (or your preferred model)
   - `DAILY_TOKEN_LIMIT` = `200` (or your preferred limit)
6. Deploy.
7. Verify:
   - `GET https://<YOUR_RENDER_URL>/health` should return `ok`.

## API Contract

### GET `/health`
Response:
```text
ok
```

### POST `/anki-ai`
Headers:
- `Authorization: Bearer <ANKI_AI_TOKEN>`
- `Content-Type: application/json`

Body:
```json
{
  "action": "explain",
  "primary": { "Text": "string", "Extra": "string" },
  "userQuestion": null,
  "deck": "string or null",
  "noteType": "string or null",
  "fields": { "optional": "object" }
}
```

`action` must be one of: `explain`, `step2`, `ask`.

## Response Format (strict)
```json
{
  "title": "string",
  "explanation": "string",
  "highYieldTakeaways": ["string"],
  "step2Question": null,
  "meta": { "cached": false }
}
```

For `action = "step2"`, `step2Question` is:
```json
{
  "stem": "string",
  "choices": { "A": "string", "B": "string", "C": "string", "D": "string", "E": "string" },
  "answer": "A",
  "rationale": "string"
}
```

## Curl Tests

Set env vars locally:
```bash
export BASE_URL="https://<YOUR_RENDER_URL>"
export ANKI_AI_TOKEN="replace-me"
```

Health:
```bash
curl -i "$BASE_URL/health"
```

Explain:
```bash
curl -s "$BASE_URL/anki-ai" \
  -H "Authorization: Bearer $ANKI_AI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"explain",
    "primary":{"Text":"A 65-year-old smoker with hematuria","Extra":"Painless gross hematuria suggests urothelial carcinoma."},
    "userQuestion":null,
    "deck":"Renal/GU",
    "noteType":"Clinical",
    "fields":{"Diagnosis":"Urothelial carcinoma"}
  }'
```

Step 2 question:
```bash
curl -s "$BASE_URL/anki-ai" \
  -H "Authorization: Bearer $ANKI_AI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"step2",
    "primary":{"Text":"Nephritic syndrome has RBC casts and hypertension.","Extra":"Post-strep GN can present after skin/throat infection."},
    "userQuestion":null,
    "deck":"Renal",
    "noteType":"Path",
    "fields":null
  }'
```

Ask:
```bash
curl -s "$BASE_URL/anki-ai" \
  -H "Authorization: Bearer $ANKI_AI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"ask",
    "primary":{"Text":"In iron deficiency anemia, ferritin is low and TIBC is high.","Extra":"MCV is often low in chronic deficiency."},
    "userQuestion":"How do labs differ from anemia of chronic disease?",
    "deck":"Heme",
    "noteType":"Labs",
    "fields":null
  }'
```

## Minimal Anki Back-Template Snippet
Replace:
- `https://<YOUR_RENDER_URL>` with your Render URL
- `Bearer <ANKI_AI_TOKEN>` with your deploy token

```html
<style>
  .anki-ai-wrap { margin-top: 12px; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
  .anki-ai-row { margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
  .anki-ai-btn { padding: 6px 10px; border: 1px solid #666; background: #f6f6f6; border-radius: 6px; cursor: pointer; }
  .anki-ai-input { flex: 1; min-width: 180px; padding: 6px; border: 1px solid #999; border-radius: 6px; }
  .anki-ai-status { margin: 6px 0; color: #555; }
  .anki-ai-error { color: #b00020; white-space: pre-wrap; }
  .anki-ai-out h4 { margin: 8px 0 4px; }
  .anki-ai-out ul { margin: 4px 0 8px 20px; padding: 0; }
</style>

<div class="anki-ai-wrap">
  <div id="anki-text-src" style="display:none;">{{Text}}</div>
  <div id="anki-extra-src" style="display:none;">{{Extra}}</div>

  <div class="anki-ai-row">
    <button class="anki-ai-btn" id="btn-explain" type="button">Explain</button>
    <button class="anki-ai-btn" id="btn-step2" type="button">Step 2 Q</button>
  </div>

  <div class="anki-ai-row">
    <input id="ask-input" class="anki-ai-input" type="text" placeholder="Ask about this card..." />
    <button class="anki-ai-btn" id="btn-ask" type="button">Ask</button>
  </div>

  <div id="anki-ai-status" class="anki-ai-status"></div>
  <div id="anki-ai-error" class="anki-ai-error"></div>
  <div id="anki-ai-output" class="anki-ai-out"></div>
</div>

<script>
  (function () {
    var textEl = document.getElementById("anki-text-src");
    var extraEl = document.getElementById("anki-extra-src");
    var askInput = document.getElementById("ask-input");
    var statusEl = document.getElementById("anki-ai-status");
    var errorEl = document.getElementById("anki-ai-error");
    var outputEl = document.getElementById("anki-ai-output");

    function getText(el) {
      return el ? (el.textContent || "") : "";
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderResult(data) {
      var html = "";
      html += "<h4>" + escapeHtml(data.title || "AI") + "</h4>";
      html += "<div>" + escapeHtml(data.explanation || "") + "</div>";

      if (Array.isArray(data.highYieldTakeaways) && data.highYieldTakeaways.length) {
        html += "<h4>High-Yield Takeaways</h4><ul>";
        for (var i = 0; i < data.highYieldTakeaways.length; i++) {
          html += "<li>" + escapeHtml(data.highYieldTakeaways[i]) + "</li>";
        }
        html += "</ul>";
      }

      if (data.step2Question) {
        var q = data.step2Question;
        html += "<h4>Step 2 Question</h4>";
        html += "<div><strong>Stem:</strong> " + escapeHtml(q.stem || "") + "</div>";
        html += "<ul>";
        html += "<li><strong>A:</strong> " + escapeHtml(q.choices && q.choices.A ? q.choices.A : "") + "</li>";
        html += "<li><strong>B:</strong> " + escapeHtml(q.choices && q.choices.B ? q.choices.B : "") + "</li>";
        html += "<li><strong>C:</strong> " + escapeHtml(q.choices && q.choices.C ? q.choices.C : "") + "</li>";
        html += "<li><strong>D:</strong> " + escapeHtml(q.choices && q.choices.D ? q.choices.D : "") + "</li>";
        html += "<li><strong>E:</strong> " + escapeHtml(q.choices && q.choices.E ? q.choices.E : "") + "</li>";
        html += "</ul>";
        html += "<div><strong>Answer:</strong> " + escapeHtml(q.answer || "") + "</div>";
        html += "<div><strong>Rationale:</strong> " + escapeHtml(q.rationale || "") + "</div>";
      }

      if (data.meta && typeof data.meta.cached === "boolean") {
        html += "<div style='margin-top:8px; color:#666;'>Cached: " + (data.meta.cached ? "yes" : "no") + "</div>";
      }

      outputEl.innerHTML = html;
    }

    async function runAction(action) {
      var userQuestion = null;
      if (action === "ask") {
        userQuestion = askInput.value ? askInput.value.trim() : "";
        if (!userQuestion) {
          errorEl.textContent = "Enter a question first.";
          outputEl.innerHTML = "";
          return;
        }
      }

      statusEl.textContent = "Loading...";
      errorEl.textContent = "";
      outputEl.innerHTML = "";

      var payload = {
        action: action,
        primary: {
          Text: getText(textEl),
          Extra: getText(extraEl)
        },
        userQuestion: userQuestion,
        deck: null,
        noteType: null,
        fields: null
      };

      try {
        var res = await fetch("https://<YOUR_RENDER_URL>/anki-ai", {
          method: "POST",
          headers: {
            "Authorization": "Bearer <ANKI_AI_TOKEN>",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        var data = await res.json().catch(function () { return null; });
        if (!res.ok) {
          throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
        }

        renderResult(data);
        statusEl.textContent = "";
      } catch (err) {
        statusEl.textContent = "";
        errorEl.textContent = "Error: " + (err && err.message ? err.message : String(err));
      }
    }

    document.getElementById("btn-explain").addEventListener("click", function () {
      runAction("explain");
    });
    document.getElementById("btn-step2").addEventListener("click", function () {
      runAction("step2");
    });
    document.getElementById("btn-ask").addEventListener("click", function () {
      runAction("ask");
    });
  })();
</script>
```

## Security Notes
- Never place `OPENAI_API_KEY` in Anki templates.
- The Anki template should only contain `ANKI_AI_TOKEN`, which you can rotate any time.
- This implementation uses in-memory cache/rate-limits; for multi-instance production scale, move these to Redis.