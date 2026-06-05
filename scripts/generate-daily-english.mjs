import fs from "node:fs/promises";
import path from "node:path";

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

const prompt = `
You are creating a daily English lesson for a Chinese beginner.

Return valid JSON only. Do not include markdown fences.

Requirements:
- About 180 to 220 words of English total.
- Use easy, beginner-friendly English.
- Topic can be a light current event or a safe general-interest modern topic.
- If you are not sure about a breaking-news fact, avoid specific claims and choose a safer topic.
- Output exactly 3 short paragraphs.
- After each English paragraph, provide a natural Chinese translation.
- Include 5 short phrases, 5 difficult words, and 5 common useful words.
- For the word hover dictionary, include every English word used in the 3 paragraphs.
- Do not miss any word, including articles, pronouns, prepositions, numbers, names, and singular/plural forms.
- Dictionary keys must use the exact basic word form that appears after removing leading or trailing punctuation.
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
  "dictionary": {
    "word": "中文"
  },
  "sourceNote": "string"
}
`;

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

  if (!data.title || !data.topic || !data.date || !data.dictionary) {
    throw new Error("Lesson is missing required top-level fields.");
  }

  assertDictionaryCoverage(data.paragraphs, data.dictionary);
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
        temperature: 0.8,
        max_tokens: 2200,
        response_format: { type: "json_object" },
        messages: buildMessages(),
      },
    },
    {
      label: "plain-text-json-fallback",
      body: {
        model: "deepseek-v4-flash",
        temperature: 0.6,
        max_tokens: 2600,
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
        return content;
      }

      failures.push(
        `${attempt.label}: empty content (finish_reason=${payload?.choices?.[0]?.finish_reason || "unknown"})`
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
        "You generate safe, beginner-friendly English study materials in strict JSON.",
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}

async function requestLesson(body) {
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
    throw new Error(`DeepSeek API failed: ${response.status} ${errorBody}`);
  }

  return response.json();
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

  return "";
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

function buildWordMap(dictionary) {
  return Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [normalizeWord(key), String(value).trim()])
  );
}

function wrapWords(text, dictionary) {
  return escapeHtml(text).replace(/[A-Za-z0-9.'-]+/g, (token) => {
    const normalized = normalizeWord(token);
    const meaning = dictionary[normalized];
    if (!meaning) {
      throw new Error(`Missing dictionary meaning for token: ${token}`);
    }

    return `<span class="word" tabindex="0" data-meaning="${escapeHtml(meaning)}">${token}</span>`;
  });
}

function normalizeWord(word) {
  return String(word)
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

function extractWordTokens(paragraphs) {
  const tokens = [];
  for (const block of paragraphs) {
    const matches = String(block.english).match(/[A-Za-z0-9.'-]+/g) || [];
    for (const token of matches) {
      const normalized = normalizeWord(token);
      if (normalized) {
        tokens.push(normalized);
      }
    }
  }
  return [...new Set(tokens)];
}

function assertDictionaryCoverage(paragraphs, dictionary) {
  const wordMap = buildWordMap(dictionary);
  const missing = extractWordTokens(paragraphs).filter((token) => !wordMap[token]);
  if (missing.length > 0) {
    throw new Error(
      `Dictionary is missing ${missing.length} article words: ${missing.join(", ")}`
    );
  }
}

function buildHtml(lessonData, currentSiteUrl) {
  const dictionary = buildWordMap(lessonData.dictionary);
  const articleHtml = lessonData.paragraphs
    .map(
      (block, index) => `
        <div class="article-block">
          <p>${wrapWords(block.english, dictionary)}</p>
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
    lessonData.summaryTipZh || "把鼠标放在英文单词上，可以看到中文翻译。每段后面都可以点击按钮查看中文。"
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
    const words = Array.from(document.querySelectorAll(".word"));

    for (const word of words) {
      word.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = !word.classList.contains("is-open");
        closeWordTooltips();
        if (willOpen) {
          word.classList.add("is-open");
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
