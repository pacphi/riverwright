import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertBlock, stripBlock, hasBlock, begin, end } from '../scripts/lib/blocks.mjs';

const SLUG = 'riverwright';
const BODY = 'Line one\nLine two';
const BLOCK = `${begin(SLUG)}\nLine one\nLine two\n${end(SLUG)}`;

test('inserting into an empty file writes the block and a final newline', () => {
  const r = upsertBlock('', SLUG, BODY);
  assert.equal(r.text, `${BLOCK}\n`);
  assert.equal(r.action, 'inserted');
});

test('inserting after content adds one blank line, and a second run changes nothing', () => {
  const once = upsertBlock('# Guide\n', SLUG, BODY).text;
  assert.equal(once, `# Guide\n\n${BLOCK}\n`);
  const twice = upsertBlock(once, SLUG, BODY);
  assert.equal(twice.text, once);
  assert.equal(twice.action, 'unchanged');
  assert.equal(twice.changed, false);
});

test('a file with no final newline keeps having none', () => {
  const once = upsertBlock('# Guide', SLUG, BODY).text;
  assert.equal(once, `# Guide\n\n${BLOCK}`);
  assert.equal(upsertBlock(once, SLUG, BODY).text, once);
});

test('CRLF files stay CRLF, including a missing final newline, and re-runs are byte-identical', () => {
  const src = '# Guide\r\nText';
  const once = upsertBlock(src, SLUG, BODY).text;
  assert.equal(once, `# Guide\r\nText\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}`);
  assert.equal(upsertBlock(once, SLUG, BODY).text, once);
});

test('mixed line endings outside the block are preserved exactly', () => {
  const src = 'a\r\nb\nc\r\n';
  const once = upsertBlock(src, SLUG, BODY).text;
  assert.ok(once.startsWith(src));
});

test('updating replaces only our block and leaves other tools\' blocks alone', () => {
  const other = '<!-- BEGIN agentic-kit-project-guidance -->\nak stuff\n<!-- END agentic-kit-project-guidance -->\n';
  const once = upsertBlock(other, SLUG, BODY).text;
  const updated = upsertBlock(once, SLUG, 'New body').text;
  assert.ok(updated.startsWith(other));
  assert.match(updated, /New body/);
  assert.doesNotMatch(updated, /Line one/);
});

test('a block whose name only starts with ours is not ours', () => {
  const extra = '<!-- BEGIN riverwright-extra -->\nkeep me\n<!-- END riverwright-extra -->\n';
  const r = upsertBlock(extra, SLUG, BODY);
  assert.equal(r.action, 'inserted');
  assert.ok(r.text.startsWith(extra));
  assert.equal(hasBlock(extra, SLUG), false);
});

test('an orphaned BEGIN gets a fresh block appended and loses nothing', () => {
  const damaged = `intro\n${begin(SLUG)}\nuser text after the orphan\n`;
  const r = upsertBlock(damaged, SLUG, BODY);
  assert.equal(r.orphanedBegin, true);
  assert.ok(r.text.startsWith(damaged));
  assert.equal(upsertBlock(r.text, SLUG, BODY).text, r.text);
});

test('stripBlock restores the original exactly for every insert shape', () => {
  for (const original of ['', '# Guide\n', '# Guide', '# Guide\r\nText', 'a\n\n', 'a\r\nb\nc\r\n']) {
    const inserted = upsertBlock(original, SLUG, BODY).text;
    const back = stripBlock(inserted, SLUG);
    assert.equal(back.removed, true);
    assert.equal(back.text, original, JSON.stringify(original));
  }
  assert.deepEqual(stripBlock('no block here\n', SLUG), { text: 'no block here\n', removed: false });
});

test('invalid block names are rejected', () => {
  assert.throws(() => upsertBlock('', 'Bad Name', BODY), /not a valid block name/);
});
