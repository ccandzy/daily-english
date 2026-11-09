import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const source = await fs.readFile(new URL('../scripts/generate-daily-english.mjs', import.meta.url), 'utf8');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-grammar-test-'));
const modulePath = path.join(dir, 'generator.mjs');
await fs.writeFile(modulePath, source.replace('await main();', '').replace('console.log(prompt);', '') + '\nexport {parseGrammarPoints, parseMarkdownLesson, buildHtml, buildGrammar, createFallbackLesson};');
const m = await import(modulePath);
await fs.rm(dir, {recursive: true});
const paragraphs = [{english: 'Although I was tired, I finished my work. I can read English.'}];
const block = (name = 'although：让步从句', sentence = 'Although I was tired, I finished my work.') => `### Grammar 1
**Name:** ${name}
**Sentence:** ${sentence}
**Structure:** although + 从句，主句
**Explanation:** 表示虽然，不和 but 连用。
**Example:** Although it rained, we went outside.
**Example Translation:** 虽然下雨了，我们还是出去了。
`;
const section = (body) => `## Grammar Points\n${body}`;

test('accepts exact article sentences and rejects invented or partial quotes', () => {
  assert.equal(m.parseGrammarPoints(section(block()), paragraphs).length, 1);
  assert.equal(m.parseGrammarPoints(section(block('不存在', 'She likes tea.')), paragraphs).length, 0);
  assert.equal(m.parseGrammarPoints(section(block('片段', 'I finished my work.')), paragraphs).length, 0);
});

test('requires complete fields, removes duplicates, caps at three', () => {
  assert.equal(m.parseGrammarPoints(section(block().replace('**Example Translation:** 虽然下雨了，我们还是出去了。', '')), paragraphs).length, 0);
  assert.equal(m.parseGrammarPoints(section(block() + block()), paragraphs).length, 1);
  assert.equal(m.parseGrammarPoints(section([1,2,3,4].map(i => block(`语法 ${i}`)).join('')), paragraphs).length, 3);
});

test('renders escaped, native collapsible cards and hides absent grammar', () => {
  const points = m.parseGrammarPoints(section(block('<script>语法</script>')), paragraphs);
  const html = m.buildGrammar(points);
  assert.ok(html.includes('<details class="grammar-card">'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(m.buildGrammar(undefined), '');
});

test('full lesson accepts optional grammar without changing paragraph or vocabulary parsing', () => {
  const fallback = m.createFallbackLesson();
  const body = fallback.paragraphs.map((p,i) => `## Paragraph ${i+1}\n${p.english}\n\n**中文翻译:** ${p.chinese}`).join('\n\n');
  const lists = [['Phrases',fallback.phrases],['Hard Words',fallback.hardWords],['Common Words',fallback.commonWords]].map(([name,items]) => `## ${name}\n${items.map(item => `- **${item.term}**: ${item.meaning}`).join('\n')}`).join('\n\n');
  const md = `# Example\n\n${body}\n\n${lists}`;
  assert.equal(m.parseMarkdownLesson(md).grammarPoints.length, 0);
  const sentence = fallback.paragraphs[0].english.split('. ')[0] + '.';
  const lesson = m.parseMarkdownLesson(md + '\n\n' + section(block('否定句',sentence)));
  assert.equal(lesson.paragraphs.length, 3);
  assert.equal(lesson.commonWords.length, 5);
  assert.equal(lesson.grammarPoints.length, 1);
  assert.ok(m.buildHtml(lesson,'').includes('语法小课堂'));
  assert.ok(!m.buildHtml(fallback,'').includes('语法小课堂'));
});
