import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyFilterProgram,
    compileFilterProgram,
    getRegexExportTerms,
    normalizeDeleteRule,
    normalizeReplaceRule,
} from '../filter-engine.js';
import { invertPatch, restoreBackupEntry, createBackupEntry } from '../message-backup.js';

const run = (text, settings) => applyFilterProgram(text, compileFilterProgram({ deleteRules: [], replaceRules: [], ...settings }));

function assertReversible(source, result) {
    const inverted = invertPatch(result.text, result.edits);
    assert.equal(inverted.ok, true);
    assert.equal(inverted.text, source);
    const entry = createBackupEntry(source, result.text, result.edits);
    assert.deepEqual(restoreBackupEntry(result.text, entry), { ok: true, text: source });
}

test('deletes ASCII words on word boundaries only', () => {
    const result = run('very veryx very.', { deleteRules: [{ text: 'very' }] });
    assert.equal(result.text, ' veryx .');
    assertReversible('very veryx very.', result);
});

test('longer delete rules win over shorter overlapping ones', () => {
    const source = 'I like it very much. very good';
    const result = run(source, { deleteRules: [{ text: 'very' }, { text: 'very much' }] });
    assert.equal(result.text, 'I like it . good');
    assert.equal(result.stats.deleted['very much'], 1);
    assertReversible(source, result);
});

test('space collapse keeps indentation and Markdown hard breaks', () => {
    const source = '- a\n    - nested  \nword   word\n\tindented';
    const result = run(source, { deleteRules: [{ text: 'zzz' }] });
    assert.equal(result.text, '- a\n    - nested  \nword word\n\tindented');
    assertReversible(source, result);
});

test('space collapse can be turned off', () => {
    const result = run('a   b', { deleteRules: [{ text: 'zzz' }], collapseSpaces: false });
    assert.equal(result.changed, false);
});

test('code and HTML markup are protected by default', () => {
    const source = '<div class="div">div text</div>\n```\ndiv   code\n```\n`div` and div<!-- div --><style>.div{}</style>';
    const result = run(source, { deleteRules: [{ text: 'div' }] });
    assert.equal(result.text, '<div class="div"> text</div>\n```\ndiv   code\n```\n`div` and <!-- div --><style>.div{}</style>');
    assertReversible(source, result);
});

test('unclosed code fence protects the rest of the message', () => {
    const result = run('very\n```\nvery', { deleteRules: [{ text: 'very' }] });
    assert.equal(result.text, '\n```\nvery');
});

test('non-tag angle brackets are still filtered', () => {
    const result = run('<그녀> 기계적인 미소', { deleteRules: [{ text: '기계적인' }] });
    assert.equal(result.text, '<그녀> 미소');
});

test('markup protection can be turned off', () => {
    const result = run('<div>div</div>', { deleteRules: [{ text: 'div' }], protectMarkup: false });
    assert.equal(result.text, '<></>');
});

test('replacement text is literal and edits stay reversible across segments', () => {
    const source = 'cat `cat` cat <b>cat</b>';
    const result = run(source, { replaceRules: [{ from: 'cat', to: '$& dog' }] });
    assert.equal(result.text, '$& dog `cat` $& dog <b>$& dog</b>');
    assertReversible(source, result);
});

test('regex export escapes slashes and the escaped pattern compiles in unicode mode', () => {
    const settings = { deleteRules: [{ text: 'a/b', language: 'en' }, { text: 'c.d', language: 'en' }], replaceRules: [] };
    const terms = getRegexExportTerms(settings);
    assert.deepEqual(terms, ['a\\/b', 'c\\.d']);
    assert.doesNotThrow(() => new RegExp(terms.join('|'), 'u'));
    assert.equal(run('x a/b y', settings).text, 'x y');
});

test('rules without a language are auto-classified', () => {
    assert.equal(normalizeDeleteRule({ text: '기계적인' }).language, 'ko');
    assert.equal(normalizeDeleteRule({ text: 'mechanical', language: '' }).language, 'en');
    assert.equal(normalizeReplaceRule({ from: '機械的' }).language, 'zh');
    assert.equal(normalizeDeleteRule({ text: 'x', language: 'custom' }).language, 'custom');
});
