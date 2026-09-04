import fs from "node:fs/promises";
import path from "node:path";
import fsSync from "node:fs";

const apiKey = process.env.DEEPSEEK_API_KEY;
const siteUrl = process.env.SITE_URL || "";

// API Key 缺失时不再直接退出。后面会自动使用本地备用课程，保证页面仍能更新。

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

Return content in the following Markdown format. Do not include markdown code fences or any text before/after.

Requirements:
- About 150 to 180 words of English total.
- Use slightly more challenging but still clear English (around CEFR A2-B1).
- Topic can be a light current event or a safe general-interest modern topic.
- If you are not sure about a breaking-news fact, avoid specific claims and choose a safer topic.
- Output exactly 3 short paragraphs.
- After each English paragraph, provide a natural Chinese translation.
- Include 5 short phrases, 5 difficult words, and 5 common useful words.
- Use concise Chinese translations.

Markdown format:
# [Title of the Lesson]

**Topic:** [topic name]
**Summary Tip:** [brief learning tip in Chinese]

## Paragraph 1
[English text]

**中文翻译:** [Chinese translation]

## Paragraph 2
[English text]

**中文翻译:** [Chinese translation]

## Paragraph 3
[English text]

**中文翻译:** [Chinese translation]

## Phrases (Short Phrases)
- **[phrase 1]**: [meaning in Chinese]
- **[phrase 2]**: [meaning in Chinese]
- **[phrase 3]**: [meaning in Chinese]
- **[phrase 4]**: [meaning in Chinese]
- **[phrase 5]**: [meaning in Chinese]

## Hard Words (Difficult Words)
- **[word 1]**: [meaning in Chinese]
- **[word 2]**: [meaning in Chinese]
- **[word 3]**: [meaning in Chinese]
- **[word 4]**: [meaning in Chinese]
- **[word 5]**: [meaning in Chinese]

## Common Words (Useful Words)
- **[word 1]**: [meaning in Chinese]
- **[word 2]**: [meaning in Chinese]
- **[word 3]**: [meaning in Chinese]
- **[word 4]**: [meaning in Chinese]
- **[word 5]**: [meaning in Chinese]
`;

console.log("=== DeepSeek Prompt Start ===");
console.log(prompt);
console.log("=== DeepSeek Prompt End ===");

await main();

async function main() {
  const warnings = [];
  let content = "";

  try {
    content = await generateLessonContent();
  } catch (error) {
    warnings.push(`AI content unavailable: ${error.message}`);
  }

  let lesson;
  try {
    lesson = parseMarkdownLesson(content);
  } catch (error) {
    warnings.push(`Markdown parser failed: ${error.message}`);
    lesson = createFallbackLesson();
  }

  lesson = repairLesson(lesson, content, warnings);

  let html;
  try {
    html = buildHtml(lesson, siteUrl);
  } catch (error) {
    warnings.push(`HTML build failed; using a fully local lesson: ${error.message}`);
    lesson = createFallbackLesson();
    html = buildHtml(lesson, siteUrl);
  }

  const archiveDir = path.join(process.cwd(), "archive");
  const results = await Promise.allSettled([
    fs.mkdir(archiveDir, { recursive: true }).then(() =>
      writeFileAtomically(path.join(archiveDir, `${shanghaiDate}.html`), html)
    ),
    writeFileAtomically(path.join(process.cwd(), "index.html"), html),
  ]);

  const labels = [`archive/${shanghaiDate}.html`, "index.html"];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      console.log(`✅ ${labels[index]} updated successfully.`);
    } else {
      console.error(`❌ ${labels[index]} update failed: ${result.reason?.message || result.reason}`);
    }
  });

  for (const warning of warnings) console.warn(`⚠️  ${warning}`);

  if (results.every((result) => result.status === "rejected")) {
    throw new Error("Both HTML writes failed; no output file could be updated.");
  }
}

// ========== Markdown 解析函数 ==========

function parseMarkdownLesson(markdown) {
  const text = normalizeMarkdown(markdown);
  const lines = text.split("\n");
  const title = cleanMarkdownText(
    lines.find((line) => /^\s*#(?!#)\s+\S/.test(line))?.replace(/^\s*#\s+/, "") || ""
  );
  const topic = readMetadata(lines, ["topic", "主题"]);
  const summaryTipZh = readMetadata(lines, ["summary tip", "learning tip", "学习要点", "学习提示"]);

  const paragraphs = [];
  let current = null;
  let mode = "english";

  const flushParagraph = () => {
    if (!current) return;
    const english = cleanParagraph(current.english.join(" "));
    const chinese = cleanParagraph(current.chinese.join(" "));
    if (english) paragraphs.push({ english, chinese });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isParagraphHeading(line)) {
      flushParagraph();
      current = { english: [], chinese: [] };
      mode = "english";
      continue;
    }
    if (isKnownSectionHeading(line)) {
      flushParagraph();
      continue;
    }
    if (!current) continue;

    const translation = parseTranslationLine(line);
    if (translation !== null) {
      mode = "chinese";
      if (translation) current.chinese.push(translation);
      continue;
    }
    if (!line || /^#{1,6}\s+/.test(line)) continue;
    current[mode].push(line);
  }
  flushParagraph();

  // 标题结构完全失效时，只救援“看起来像英文正文”的自然段。
  if (paragraphs.length === 0) {
    paragraphs.push(...salvageEnglishParagraphs(text));
  }

  return {
    title: title || "Daily English Lesson",
    topic: topic || chosenTopic,
    date: shanghaiDate,
    summaryTipZh: summaryTipZh || "点击或悬浮英文单词查看翻译，每段后也可以展开中文。",
    paragraphs,
    phrases: parseWordList(text, ["phrases", "short phrases", "短语"]),
    hardWords: parseWordList(text, ["hard words", "difficult words", "难词", "生词"]),
    commonWords: parseWordList(text, ["common words", "useful words", "常用词"]),
    sourceNote: "AI-generated lesson for daily English reading.",
  };
}

function normalizeMarkdown(markdown) {
  return String(markdown || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*```(?:markdown|md)?\s*$/gim, "")
    .replace(/^\s*```\s*$/gim, "")
    .trim();
}

function cleanMarkdownText(value) {
  return String(value || "")
    .replace(/^\s*[-*>]+\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

function cleanParagraph(value) {
  return cleanMarkdownText(value).replace(/\s+/g, " ").trim();
}

function readMetadata(lines, names) {
  const alternatives = names.map(escapeRegExp).join("|");
  const regex = new RegExp(`^\\s*(?:\\*\\*|__)?(?:${alternatives})\\s*[:：](?:\\*\\*|__)?\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(regex);
    if (match?.[1]) return cleanMarkdownText(match[1]);
  }
  return "";
}

function isParagraphHeading(line) {
  return /^#{1,6}\s*(?:paragraph|para|section|part)\s*(?:\d+|one|two|three)?\s*[:：-]?\s*$/i.test(line);
}

function isKnownSectionHeading(line) {
  return /^#{1,6}\s*(?:phrases?|short phrases?|hard words?|difficult words?|common words?|useful words?|短语|难词|生词|常用词).*$/i.test(line);
}

function parseTranslationLine(line) {
  const match = line.match(/^\s*(?:\*\*|__)?(?:中文翻译|中文|translation|chinese translation)\s*[:：](?:\*\*|__)?\s*(.*)$/i);
  return match ? cleanMarkdownText(match[1]) : null;
}

function parseWordList(text, sectionNames, expectedCount = 5) {
  const words = [];
  const names = sectionNames.map((name) => name.toLowerCase());
  const lines = text.split("\n");
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      const normalizedHeading = cleanMarkdownText(heading[1]).replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
      inSection = names.some((name) => normalizedHeading === name || normalizedHeading.startsWith(`${name} `));
      continue;
    }
    if (!inSection || !line || words.length >= expectedCount) continue;

    const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*(?:[:：]|\s[-–—]\s)\s*(.+?)\s*$/);
    if (!item) continue;
    const term = cleanMarkdownText(item[1]);
    const meaning = cleanMarkdownText(item[2]);
    if (term && meaning) words.push({ term, meaning });
  }
  return words;
}

function salvageEnglishParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(cleanParagraph)
    .filter((block) => {
      if (!block || /^#|^(?:topic|summary tip|中文|translation)\s*[:：]/i.test(block)) return false;
      if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(block)) return false;
      const englishLetters = (block.match(/[A-Za-z]/g) || []).length;
      const chineseChars = (block.match(/[\u3400-\u9fff]/g) || []).length;
      const wordCount = (block.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
      return englishLetters > chineseChars * 2 && wordCount >= 8;
    })
    .slice(0, 3)
    .map((english) => ({ english, chinese: "" }));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function generateLessonContent() {
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing");

  const body = {
    model: "deepseek-v4-flash",
    temperature: 0.3,
    max_tokens: 4200,
    messages: buildMessages(),
  };

  const failures = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payload = await requestLesson(body);
      const content = readAssistantContent(payload);
      // 不再用固定的 100 字符卡死流程；只要有文本，就交给容错解析器尽量提取。
      if (content.trim()) {
        console.log(`✅ DeepSeek request succeeded on attempt ${attempt}.`);
        return content;
      }

      failures.push(
        `attempt ${attempt}: empty content (finish_reason=${payload?.choices?.[0]?.finish_reason || "unknown"}) ${describePayload(payload)}`
      );
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error.message}`);
    }

    if (attempt < 3) {
      await delay(attempt * 1500);
    }
  }

  throw new Error(`DeepSeek API returned no usable content. ${failures.join(" | ")}`);
}

function buildMessages() {
  return [
    {
      role: "system",
      content:
        "You generate safe, learner-friendly English study materials in Markdown format. Keep the language slightly challenging but still clear for CEFR A2-B1 learners. Return only the Markdown content, no explanations or code fences.",
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("DeepSeek API timed out after 45 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function repairLesson(data, rawContent, warnings) {
  if (!data || typeof data !== "object") {
    warnings.push("No parsed lesson object; local fallback was used.");
    return createFallbackLesson();
  }

  data.title = cleanParagraph(data.title) || "Daily English Lesson";
  data.topic = cleanParagraph(data.topic) || chosenTopic;
  data.date = shanghaiDate;
  data.summaryTipZh = cleanParagraph(data.summaryTipZh) || "点击或悬浮英文单词查看翻译，每段后也可以展开中文。";

  if (!Array.isArray(data.paragraphs)) data.paragraphs = [];
  data.paragraphs = data.paragraphs
    .map((item) => ({
      english: cleanParagraph(item?.english),
      chinese: cleanParagraph(item?.chinese),
    }))
    .filter((item) => item.english)
    .slice(0, 3);

  if (data.paragraphs.length === 0) {
    warnings.push(rawContent ? "AI text contained no usable English paragraph; local fallback was used." : "AI produced no content; local fallback was used.");
    return createFallbackLesson();
  }

  data.paragraphs.forEach((paragraph, index) => {
    if (!paragraph.chinese) {
      paragraph.chinese = "本段暂未生成中文翻译。";
      warnings.push(`Paragraph ${index + 1} has no Chinese translation.`);
    }
  });

  for (const key of ["phrases", "hardWords", "commonWords"]) {
    if (!Array.isArray(data[key])) data[key] = [];
    data[key] = data[key]
      .map((item) => ({ term: cleanParagraph(item?.term), meaning: cleanParagraph(item?.meaning) }))
      .filter((item) => item.term && item.meaning)
      .slice(0, 5);
    if (data[key].length < 5) warnings.push(`${key} contains ${data[key].length}/5 usable items.`);
  }

  data.sourceNote = cleanParagraph(data.sourceNote) || "AI-generated lesson for daily English reading.";
  return data;
}

function createFallbackLesson() {
  return {
    title: "Small Steps Make Learning Easier",
    topic: chosenTopic || "daily learning",
    date: shanghaiDate,
    summaryTipZh: "今天先完成一次短阅读。稳定的小进步，比偶尔学习很久更容易坚持。",
    paragraphs: [
      {
        english: "Learning English does not always require a long study session. Ten focused minutes can be useful when you read slowly, notice new expressions, and think about the meaning of each sentence.",
        chinese: "学习英语并不总是需要很长的学习时间。慢慢阅读、留意新表达并思考每句话的含义时，专注的十分钟也很有用。",
      },
      {
        english: "A simple daily routine can make progress easier to see. You may read one short article, choose several useful words, and then explain the main idea in your own language.",
        chinese: "简单的每日习惯可以让进步更容易被看见。你可以读一篇短文，选择几个有用的单词，然后用自己的语言解释主要内容。",
      },
      {
        english: "Some days will be busy, and your work may be incomplete. That is normal. The important thing is to return the next day and keep your learning habit alive.",
        chinese: "有些日子会很忙，学习也可能没有全部完成。这很正常。重要的是第二天继续回来，让学习习惯保持下去。",
      },
    ],
    phrases: [
      { term: "focused minutes", meaning: "专注的几分钟" },
      { term: "daily routine", meaning: "每日习惯" },
      { term: "main idea", meaning: "主要意思" },
      { term: "in your own language", meaning: "用你自己的语言" },
      { term: "keep a habit alive", meaning: "让习惯保持下去" },
    ],
    hardWords: [
      { term: "require", meaning: "需要" },
      { term: "focused", meaning: "专注的" },
      { term: "expression", meaning: "表达；短语" },
      { term: "progress", meaning: "进步" },
      { term: "incomplete", meaning: "不完整的" },
    ],
    commonWords: [
      { term: "learn", meaning: "学习" },
      { term: "read", meaning: "阅读" },
      { term: "choose", meaning: "选择" },
      { term: "explain", meaning: "解释" },
      { term: "return", meaning: "返回；再次开始" },
    ],
    sourceNote: "Local fallback lesson used because complete AI content was unavailable.",
  };
}

async function writeFileAtomically(targetPath, content) {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
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
  if (!Array.isArray(items) || items.length === 0) {
    return '<li class="empty-item">本组内容暂未完整生成</li>';
  }
  return items
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.term)}</strong>: ${escapeHtml(item.meaning)}</li>`
    )
    .join("");
}
