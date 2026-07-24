import fs from "node:fs/promises";
import path from "node:path";
import fsSync from "node:fs";

const apiKey = process.env.DEEPSEEK_API_KEY;
const siteUrl = process.env.SITE_URL || "";

if (!apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
}

const now = new Date();
const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);

// ---------- Topic rotation: topic pool + recent-topic check ----------
// 扩展后的主题池（你可以继续补充）
const topicPool = [
  "health and exercise",
  "food and cooking",
  "travel and tourism",
  "technology (gadgets)",
  "climate and environment",
  "education and study tips",
  "work and jobs",
  "sports",
  "culture and festivals",
  "daily routines",
  "hobbies and crafts",
  "pets and animals",
  "books and reading",
  "movies and entertainment",
  "weather and seasons",
  "city life and transport (non-electric)",
  "nature and outdoors",
  "science discoveries",
  "simple history stories",
  "holidays and celebrations",
  "markets and shopping",
  "money saving tips",
  "online safety and privacy",
  "language learning tips",
  "career skills and interviews"
];

function getRecentTopics(archiveDir, lookback = 12) {
  const recent = [];
  try {
    if (!fsSync.existsSync(archiveDir)) return recent;
    const files = fsSync
      .readdirSync(archiveDir)
      .filter((f) => f.endsWith(".html"))
      .sort()
      .reverse()
      .slice(0, lookback);
    for (const f of files) {
      const content = fsSync.readFileSync(path.join(archiveDir, f), "utf8");
      const m = content.match(/Topic:\s*([^<\n\r]+)/i);
      if (m && m[1]) {
        recent.push(m[1].trim().toLowerCase());
      }
    }
  } catch (e) {
    // 忽略读取错误，返回空数组
  }
  return recent;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const archiveDirPath = path.join(process.cwd(), "archive");
const recentTopics = getRecentTopics(archiveDirPath, 12);

let chosenTopic = "";
for (const t of shuffleArray(topicPool)) {
  const norm = t.toLowerCase();
  // 简单冲突检测：子串包含关系（可按需增强为更复杂的语义相似度）
  const conflict = recentTopics.some((rt) => rt.includes(norm) || norm.includes(rt));
  if (!conflict) {
    chosenTopic = t;
    break;
  }
}
if (!chosenTopic) {
  chosenTopic = topicPool[Math.floor(Math.random() * topicPool.length)];
}
// ---------- End topic rotation ----------

const prompt = `
You are creating a daily English lesson for a Chinese learner with basic foundation.

Preferred topic: ${chosenTopic}.
Topic can be a light current event or a safe general-interest modern topic. Avoid repeating recent topics found in the site's archive.

Return valid JSON only. Do not include markdown fences.
Do not show your thinking, plan, notes, analysis, or word-count process.
Do not explain the schema.
Do not output any text before or after the JSON object.

Requirements:
- About 150 to 180 words of English total.
- Use slightly more challenging but still clear English (around CEFR A2-B1).
- Topic can be a light current event or a safe general-interest modern topic.
- If you are not sure about a breaking-news fact, avoid specific claims and choose a safer topic.
- Output exactly 3 short paragraphs.
- After each English paragraph, provide a natural Chinese translation.
- Include 5 short phrases, 5 difficult words, and 5 common useful words.
- Use concise Chinese translations.

JSON schema:
{
  "title": "string",
  "topic": "string",
  "date": "${shanghaiDate}",
  "summaryTipZh": "string",
  "paragraphs": [
    { "english": "string", "chinese": "string" }
  ],
  "phrases": [
    { "term": "string", "meaning": "string" }
  ],
  "hardWords": [
    { "term": "string", "meaning": "string" }
  ],
  "commonWords": [
    { "term": "string", "meaning": "string" }
  ],
  "sourceNote": "string"
}
`;

console.log("=== DeepSeek Prompt Start ===");
console.log(prompt);
console.log("=== DeepSeek Prompt End ===");

const content = await generateLessonContent();

let lesson;
try {
  lesson = JSON.parse(extractJsonString(content));
} catch (error) {
  throw new Error(`Failed to parse lesson JSON: ${error.message}\n${content}`);
}

validateLesson(lesson);

const html = buildHtml(lesson, siteUrl);
const archiveDir = path.join(process.cwd(), "archive");
await fs.mkdir(archiveDir, { recursive: true });
await fs.writeFile(path.join(process.cwd(), "index.html"), html, "utf8");
await fs.writeFile(path.join(archiveDir, `${shanghaiDate}.html`), html, "utf8");

function validateLesson(data) {
  const requiredArrays = ["paragraphs", "phrases", "hardWords", "commonWords"];
  for (const key of requiredArrays) {
    if (!Array.isArray(data[key]) || data[key].length === 0) {
      throw new Error(`Lesson field "${key}" is missing or empty.`);
    }
  }

  if (!data.title || !data.topic || !data.date) {
    throw new Error("Lesson is missing required top-level fields.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function generateLessonContent() {
  const attempts = [
    {
      label: "json-response-format",
      body: {
        model: "deepseek-v4-flash",
        temperature: 0.3,
        max_tokens: 4200,
        response_format: { type: "json_object" },
        messages: buildMessages(),
      },
    },
    {
      label: "plain-text-json-fallback",
      body: {
        model: "deepseek-v4-flash",
        temperature: 0.2,
        max_tokens: 4200,
        messages: buildMessages(),
      },
    },
  ];

  const failures = [];

  for (const attempt of attempts) {
    try {
      const payload = await requestLesson(attempt.body);
      const content = readAssistantContent(payload);
      if (content) {
        const extracted = extractJsonString(content);
        if (looksLikeJsonObject(extracted)) {
          return extracted;
        }

        const repaired = await repairLessonContent(content);
        if (repaired) {
          return repaired;
        }

        failures.push(
          `${attempt.label}: non-JSON content ${describePayload(payload)}`
        );
        continue;
      }

      failures.push(
        `${attempt.label}: empty content (finish_reason=${payload?.choices?.[0]?.finish_reason || "unknown"}) ${describePayload(payload)}`
      );
    } catch (error) {
      failures.push(`${attempt.label}: ${error.message}`);
    }
  }

  throw new Error(`DeepSeek API returned no usable content. ${failures.join(" | ")}`);
}

function buildMessages() {
  return [
    {
      role: "system",
      content:
        "You generate safe, learner-friendly English study materials in strict JSON. Keep the language slightly challenging but still clear for CEFR A2-B1 learners. Never reveal chain-of-thought,[...]",
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}

async function requestLesson(body) {
  console.log("=== DeepSeek Request Body Start ===");
  console.log(JSON.stringify(body, null, 2));
  console.log("=== DeepSeek Request Body End ===");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.log("=== DeepSeek Error Response Start ===");
    console.log(errorBody);
    console.log("=== DeepSeek Error Response End ===");
    throw new Error(`DeepSeek API failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  console.log("=== DeepSeek Raw Response Start ===");
  console.log(JSON.stringify(payload, null, 2));
  console.log("=== DeepSeek Raw Response End ===");
  return payload;
}

function readAssistantContent(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text" && typeof item.text === "string") {
          return item.text;
        }

        return "";
      })
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  if (typeof choice?.text === "string" && choice.text.trim()) {
    return choice.text.trim();
  }

  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }

  return "";
}

function describePayload(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  const contentPreview = Array.isArray(content)
    ? content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item?.type === "text" && typeof item.text === "string") {
            return item.text;
          }
          return JSON.stringify(item);
        })
        .join("")
    : typeof content === "string"
      ? content
      : "";

  const debug = {
    finish_reason: choice?.finish_reason || null,
    content_type: Array.isArray(content) ? "array" : typeof content,
    content_length: contentPreview.length,
    content_preview: contentPreview.slice(0, 400),
    reasoning_length: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0,
    reasoning_preview:
      typeof message?.reasoning_content === "string"
        ? message.reasoning_content.slice(0, 400)
        : "",
  };

  return JSON.stringify(debug);
}

function extractJsonString(content) {
  const trimmed = String(content).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function looksLikeJsonObject(text) {
  const trimmed = String(text).trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

async function repairLessonContent(rawContent) {
  const repairPrompt = `
Convert the following model output into one valid JSON object only.

Rules:
- Output valid JSON only.
- Do not include markdown fences.
- Do not include analysis, notes, planning, or word counts.
- Use the lesson content already present in the draft.
- If the draft contains planning text, ignore it and keep only the final lesson result.
- Preserve the required schema exactly.

Draft content:
${rawContent}
`;

  console.log("=== DeepSeek Repair Prompt Start ===");
  console.log(repairPrompt);
  console.log("=== DeepSeek Repair Prompt End ===");

  const payload = await requestLesson({
    model: "deepseek-v4-flash",
    temperature: 0.1,
    max_tokens: 4200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You convert messy lesson drafts into one strict JSON object. Return only JSON and never include reasoning.",
      },
      {
        role: "user",
        content: repairPrompt,
      },
    ],
  });

  const content = readAssistantContent(payload);
  const extracted = extractJsonString(content);
  if (looksLikeJsonObject(extracted)) {
    return extracted;
  }

  return "";
}

function wrapWords(text) {
  return escapeHtml(text).replace(/[A-Za-z0-9.'-]+/g, (token) => {
    const normalized = normalizeWord(token);
    return `<span class="word" tabindex="0" data-word="${escapeHtml(normalized)}" data-meaning="点击或悬浮可翻译">${token}</span>`;
  });
}

function normalizeWord(word) {
  return String(word)
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

function buildHtml(lessonData, currentSiteUrl) {
  const articleHtml = lessonData.paragraphs
    .map(
      (block, index) => `
        <div class="article-block">
          <p>${wrapWords(block.english)}</p>
          <button class="toggle-btn" type="button" onclick="toggleTranslation(${index}, this)">显示中文翻译</button>
          <div class="translation" id="translation-${index}">${escapeHtml(block.chinese)}</div>
        </div>
      `
    )
    .join("");

  const phrasesHtml = buildList(lessonData.phrases);
  const hardWordsHtml = buildList(lessonData.hardWords);
  const commonWordsHtml = buildList(lessonData.commonWords);
  const safeTitle = escapeHtml(lessonData.title);
  const safeTopic = escapeHtml(lessonData.topic);
  const safeDate = escapeHtml(lessonData.date);
  const safeTip = escapeHtml(
    lessonData.summaryTipZh || "把鼠标放在英文单词上，或在手机上点击英文单词，可以实时查看中文翻译。每段后面都可以点击按钮查看中文。"
  );
  const safeSource = escapeHtml(lessonData.sourceNote || "AI-generated lesson for daily English reading.");
  const safeUrl = currentSiteUrl ? `<a href="${escapeHtml(currentSiteUrl)}">${escapeHtml(currentSiteUrl)}</a>` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg-a: #f4efe7;
      --bg-b: #dcecf2;
      --paper: #fffdf8;
      --sidebar: #edf6fb;
      --ink: #22363c;
      --muted: #64777c;
      --accent: #11765f;
      --accent-deep: #0b5948;
      --line: #cad9dd;
      --hover: #d8f4ec;
      --tooltip: #17353a;
      --soft: #edf9f4;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      line-height: 1.75;
      background:
        radial-gradient(circle at top left, rgba(255, 255, 255, 0.55), transparent 28%),
        linear-gradient(145deg, var(--bg-a) 0%, var(--bg-b) 100%);
    }

    .page {
      max-width: 1220px;
      margin: 28px auto;
      padding: 18px;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 2.15fr) minmax(280px, 0.95fr);
      gap: 22px;
      align-items: start;
    }

    .card,
    .sidebar {
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: 0 18px 38px rgba(32, 67, 75, 0.08);
    }

    .card {
      background: var(--paper);
      padding: 30px;
    }

    .sidebar {
      background: var(--sidebar);
      padding: 22px;
      position: sticky;
      top: 18px;
    }

    h1 {
      margin: 0 0 10px;
      font-size: clamp(30px, 4vw, 45px);
      line-height: 1.12;
    }

    h2 {
      margin: 0 0 10px;
      font-size: 18px;
      letter-spacing: 0.02em;
    }

    .meta {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 15px;
    }

    .tip {
      margin: 0 0 24px;
      padding: 12px 14px;
      border-left: 4px solid var(--accent);
      border-radius: 12px;
      background: var(--soft);
      color: #28544b;
    }

    .article-block {
      margin-bottom: 24px;
      padding-bottom: 22px;
      border-bottom: 1px dashed var(--line);
    }

    .article-block:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: 0;
    }

    .article-block p {
      margin: 0 0 12px;
      font-size: 21px;
    }

    .toggle-btn {
      border: 0;
      border-radius: 999px;
      padding: 9px 16px;
      font-size: 14px;
      font-family: inherit;
      background: var(--accent);
      color: #f7fffd;
      cursor: pointer;
      transition: transform 0.15s ease, background-color 0.15s ease;
    }

    .toggle-btn:hover {
      transform: translateY(-1px);
      background: var(--accent-deep);
    }

    .translation {
      display: none;
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: #f3fcf8;
      color: #355556;
      font-size: 16px;
    }

    .translation.show {
      display: block;
    }

    .word {
      position: relative;
      display: inline-block;
      padding: 0 2px;
      border-radius: 5px;
      cursor: help;
      transition: background-color 0.15s ease;
    }

    .word:hover {
      background: var(--hover);
    }

    .word:hover::after,
    .word:active::after,
    .word:focus-visible::after,
    .word.is-open::after {
      content: attr(data-meaning);
      position: absolute;
      left: 50%;
      bottom: calc(100% + 8px);
      transform: translateX(-50%);
      min-width: 64px;
      max-width: 180px;
      padding: 6px 9px;
      border-radius: 10px;
      background: var(--tooltip);
      color: #f4fdfd;
      font-size: 13px;
      line-height: 1.35;
      text-align: center;
      white-space: normal;
      z-index: 2;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
    }

    .label {
      display: inline-block;
      margin-bottom: 8px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(17, 118, 95, 0.12);
      color: var(--accent-deep);
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .side-section {
      margin-bottom: 22px;
    }

    .side-section:last-child {
      margin-bottom: 0;
    }

    .side-section ul {
      margin: 0;
      padding-left: 20px;
    }

    .side-section li {
      margin-bottom: 10px;
      color: #304248;
      font-size: 15px;
    }

    .footer {
      margin-top: 24px;
      color: var(--muted);
      font-size: 14px;
    }

    .footer a {
      color: var(--accent-deep);
    }

    @media (max-width: 920px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .sidebar {
        position: static;
      }
    }

    @media (max-width: 640px) {
      .page {
        margin: 14px auto;
        padding: 10px;
      }

      .card,
      .sidebar {
        padding: 18px;
        border-radius: 18px;
      }

      .article-block p {
        font-size: 18px;
      }

      .word:hover::after,
      .word:active::after,
      .word:focus-visible::after,
      .word.is-open::after {
        left: 0;
        transform: none;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="layout">
      <main class="card">
        <h1>${safeTitle}</h1>
        <p class="meta">Date: ${safeDate} | Level: Beginner | Topic: ${safeTopic}</p>
        <p class="tip">${safeTip}</p>
        <section id="article">${articleHtml}</section>
        <p class="footer">
          ${safeSource}
          <br>Word translation on hover or tap uses the MyMemory public translation API.
          ${safeUrl ? `<br>Site: ${safeUrl}` : ""}
        </p>
      </main>

      <aside class="sidebar">
        <div class="side-section">
          <span class="label">Phrases</span>
          <h2>Short Phrases</h2>
          <ul>${phrasesHtml}</ul>
        </div>

        <div class="side-section">
          <span class="label">Hard Words</span>
          <h2>Difficult Words</h2>
          <ul>${hardWordsHtml}</ul>
        </div>

        <div class="side-section">
          <span class="label">Common Words</span>
          <h2>Useful Words</h2>
          <ul>${commonWordsHtml}</ul>
        </div>
      </aside>
    </div>
  </div>

  <script>
    const translationCache = new Map();
    const words = Array.from(document.querySelectorAll(".word"));

    for (const word of words) {
      word.addEventListener("mouseenter", () => {
        loadTranslation(word);
      });

      word.addEventListener("focus", () => {
        loadTranslation(word);
      });

      word.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = !word.classList.contains("is-open");
        closeWordTooltips();
        if (willOpen) {
          word.classList.add("is-open");
          loadTranslation(word);
        }
      });
    }

    document.addEventListener("click", () => {
      closeWordTooltips();
    });

    function closeWordTooltips() {
      for (const word of words) {
        word.classList.remove("is-open");
      }
    }

    async function loadTranslation(word) {
      const key = word.dataset.word || normalizeWord(word.textContent || "");
      if (!key) {
        word.dataset.meaning = "暂无翻译";
        return;
      }

      if (translationCache.has(key)) {
        word.dataset.meaning = translationCache.get(key);
        return;
      }

      word.dataset.meaning = "翻译中...";

      try {
        const params = new URLSearchParams({
          q: key,
          langpair: "en|zh-CN",
          mt: "1"
        });
        const response = await fetch("https://api.mymemory.translated.net/get?" + params.toString());
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }

        const data = await response.json();
        const translated =
          data?.responseData?.translatedText ||
          data?.matches?.find((item) => item?.translation)?.translation ||
          "";

        const clean = normalizeTranslation(translated, key);
        const finalMeaning = clean || "暂无翻译";
        translationCache.set(key, finalMeaning);
        word.dataset.meaning = finalMeaning;
      } catch (error) {
        const fallback = localFallback(key);
        const finalMeaning = fallback || "翻译失败，请稍后再试";
        translationCache.set(key, finalMeaning);
        word.dataset.meaning = finalMeaning;
      }
    }

    function normalizeWord(value) {
      return String(value).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    }

    function normalizeTranslation(value, sourceWord) {
      const text = String(value || "").trim();
      if (!text) {
        return "";
      }

      const lowered = text.toLowerCase();
      if (lowered === String(sourceWord).toLowerCase()) {
        return "";
      }

      return text.replace(/^zh-cn\\|/i, "").trim();
    }

    function localFallback(word) {
      const fallback = {
        a: "一个",
        an: "一个",
        and: "和",
        are: "是",
        in: "在……里",
        is: "是",
        of: "……的",
        on: "在……上",
        the: "这；这个",
        to: "到；去；用于不定式"
      };
      return fallback[word] || "";
    }

    function toggleTranslation(index, button) {
      const el = document.getElementById("translation-" + index);
      const isOpen = el.classList.toggle("show");
      button.textContent = isOpen ? "隐藏中文翻译" : "显示中文翻译";
    }
  </script>
</body>
</html>`;
}

function buildList(items) {
  return items
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.term)}</strong>: ${escapeHtml(item.meaning)}</li>`
    )
    .join("");
}
