export const DEFAULT_LANGUAGE_GROUPS = Object.freeze([
    { id: 'ko', name: '한국어' },
    { id: 'en', name: 'English' },
    { id: 'ja', name: '日本語' },
    { id: 'zh', name: '中文' },
    { id: 'other', name: '기타' },
]);

export function escapeRegex(value) {
    // `/` is escaped as well so exported terms survive `/pattern/flags` notation.
    return String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function makePattern(term) {
    const value = String(term ?? '').trim();
    if (!value) return '';

    const escaped = escapeRegex(value);
    return /^[A-Za-z0-9_]+$/u.test(value) ? `\\b${escaped}\\b` : escaped;
}

export function detectLanguageGroup(value) {
    const text = String(value ?? '');
    if (/\p{Script=Hangul}/u.test(text)) return 'ko';
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    if (/\p{Script=Latin}/u.test(text)) return 'en';
    return 'other';
}

export function splitEntries(value) {
    return String(value ?? '')
        .split(/[\n,]+/u)
        .map(item => item.trim())
        .filter(Boolean);
}

export function normalizeDeleteRule(rule, fallbackLanguage = 'other') {
    if (typeof rule === 'string') {
        return { id: '', text: rule.trim(), language: detectLanguageGroup(rule) || fallbackLanguage };
    }

    const text = String(rule?.text ?? rule?.word ?? '').trim();
    return {
        id: String(rule?.id ?? ''),
        text,
        language: String(rule?.language || detectLanguageGroup(text) || fallbackLanguage),
    };
}

export function normalizeReplaceRule(rule, fallbackLanguage = 'other') {
    return {
        id: String(rule?.id ?? ''),
        from: String(rule?.from ?? '').trim(),
        to: String(rule?.to ?? ''),
        language: String(rule?.language || detectLanguageGroup(rule?.from) || fallbackLanguage),
    };
}

export function createEmptyStats() {
    return {
        deleted: Object.create(null),
        replaced: Object.create(null),
        totalDeleted: 0,
        totalReplaced: 0,
    };
}

export function mergeStats(target, source) {
    if (!source) return target;

    target.totalDeleted += source.totalDeleted || 0;
    target.totalReplaced += source.totalReplaced || 0;

    for (const [key, count] of Object.entries(source.deleted || {})) {
        target.deleted[key] = (target.deleted[key] || 0) + count;
    }
    for (const [key, count] of Object.entries(source.replaced || {})) {
        target.replaced[key] = (target.replaced[key] || 0) + count;
    }

    return target;
}

function compileRule(term, caseSensitive) {
    const pattern = makePattern(term);
    if (!pattern) return null;

    return {
        regex: new RegExp(pattern, caseSensitive ? 'gu' : 'giu'),
        pattern,
    };
}

export function compileFilterProgram(settings) {
    const caseSensitive = Boolean(settings?.caseSensitive);
    const replaceRules = [];
    const deleteRules = [];

    for (const rawRule of Array.isArray(settings?.replaceRules) ? settings.replaceRules : []) {
        const rule = normalizeReplaceRule(rawRule);
        if (!rule.from) continue;
        const compiled = compileRule(rule.from, caseSensitive);
        if (!compiled) continue;
        replaceRules.push({ ...rule, ...compiled });
    }

    for (const rawRule of Array.isArray(settings?.deleteRules) ? settings.deleteRules : []) {
        const rule = normalizeDeleteRule(rawRule);
        if (!rule.text) continue;
        const compiled = compileRule(rule.text, caseSensitive);
        if (!compiled) continue;
        deleteRules.push({ ...rule, ...compiled });
    }
    // Longer terms run first so "very much" is not pre-empted by "very".
    // Array.prototype.sort is stable, so equal lengths keep the list order.
    deleteRules.sort((a, b) => b.text.length - a.text.length);

    const allPatterns = [...replaceRules, ...deleteRules].map(rule => `(?:${rule.pattern})`);
    const quickRegex = allPatterns.length
        ? new RegExp(allPatterns.join('|'), caseSensitive ? 'u' : 'iu')
        : null;
    return Object.freeze({
        enabled: settings?.enabled !== false,
        collapseSpaces: settings?.collapseSpaces !== false,
        protectMarkup: settings?.protectMarkup !== false,
        replaceRules,
        deleteRules,
        quickRegex,
        hasRules: replaceRules.length > 0 || deleteRules.length > 0,
    });
}

/**
 * Applies one literal regular-expression rule and records a reversible edit list.
 * Each edit is [positionInCurrentState, removedText, insertedText].
 */
function replaceWithEdits(input, rule, replacement, edits) {
    const regex = rule.regex;
    regex.lastIndex = 0;
    if (!regex.test(input)) {
        regex.lastIndex = 0;
        return { text: input, count: 0 };
    }
    regex.lastIndex = 0;

    let match;
    let cursor = 0;
    let delta = 0;
    let count = 0;
    const chunks = [];

    while ((match = regex.exec(input)) !== null) {
        const removed = String(match[0] ?? '');
        if (!removed) {
            regex.lastIndex += 1;
            continue;
        }

        const inserted = String(replacement ?? '');
        chunks.push(input.slice(cursor, match.index), inserted);
        const position = match.index + delta;
        edits.push([position, removed, inserted]);
        delta += inserted.length - removed.length;
        cursor = match.index + removed.length;
        count += 1;
    }

    if (count === 0) return { text: input, count: 0 };
    chunks.push(input.slice(cursor));
    return { text: chunks.join(''), count };
}

// Only runs between two non-space characters (or before the end of a
// segment), so line indentation and Markdown hard breaks ("  \n") survive.
const COLLAPSIBLE_SPACES = /(?<=\S)[ \t]{2,}(?=\S|$)/gu;

// Code fences, inline code, HTML comments, <style>/<script> blocks and HTML
// tags are left untouched. Text between tags is still filtered.
const PROTECTED_MARKUP = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|<!--[\s\S]*?(?:-->|$)|<(style|script)\b[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][^<>]*>/giu;

export function splitProtectedSegments(text) {
    const source = String(text ?? '');
    const segments = [];
    let cursor = 0;
    PROTECTED_MARKUP.lastIndex = 0;
    let match;
    while ((match = PROTECTED_MARKUP.exec(source)) !== null) {
        if (!match[0]) {
            PROTECTED_MARKUP.lastIndex += 1;
            continue;
        }
        if (match.index > cursor) segments.push({ text: source.slice(cursor, match.index), protected: false });
        segments.push({ text: match[0], protected: true });
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length) segments.push({ text: source.slice(cursor), protected: false });
    return segments;
}

function collapseSpacesWithEdits(input, edits) {
    return replaceWithEdits(input, { regex: COLLAPSIBLE_SPACES }, ' ', edits);
}

function hasCollapsibleSpaces(text) {
    COLLAPSIBLE_SPACES.lastIndex = 0;
    const found = COLLAPSIBLE_SPACES.test(text);
    COLLAPSIBLE_SPACES.lastIndex = 0;
    return found;
}

function filterSegment(input, program, stats, edits) {
    let result = input;

    for (const rule of program.replaceRules) {
        const applied = replaceWithEdits(result, rule, rule.to, edits);
        result = applied.text;
        if (applied.count > 0) {
            const key = `${rule.from} → ${rule.to || '(삭제)'}`;
            stats.replaced[key] = (stats.replaced[key] || 0) + applied.count;
            stats.totalReplaced += applied.count;
        }
    }

    for (const rule of program.deleteRules) {
        const applied = replaceWithEdits(result, rule, '', edits);
        result = applied.text;
        if (applied.count > 0) {
            stats.deleted[rule.text] = (stats.deleted[rule.text] || 0) + applied.count;
            stats.totalDeleted += applied.count;
        }
    }

    if (program.collapseSpaces) {
        result = collapseSpacesWithEdits(result, edits).text;
    }
    return result;
}

export function applyFilterProgram(text, program) {
    const source = String(text ?? '');
    if (!program?.enabled || !program?.hasRules || !source) {
        return { text: source, stats: createEmptyStats(), changed: false, edits: [] };
    }

    const hasRuleMatch = (() => {
        if (!program.quickRegex) return false;
        program.quickRegex.lastIndex = 0;
        return program.quickRegex.test(source);
    })();
    if (!hasRuleMatch && !(program.collapseSpaces && hasCollapsibleSpaces(source))) {
        return { text: source, stats: createEmptyStats(), changed: false, edits: [] };
    }

    const segments = program.protectMarkup
        ? splitProtectedSegments(source)
        : [{ text: source, protected: false }];
    const stats = createEmptyStats();
    const edits = [];
    const output = [];
    // Segments are filtered left to right, so each edit position is shifted by
    // the length of the already-filtered prefix. invertPatch stays valid.
    let offset = 0;

    for (const segment of segments) {
        if (segment.protected) {
            output.push(segment.text);
            offset += segment.text.length;
            continue;
        }
        const segmentEdits = [];
        const filtered = filterSegment(segment.text, program, stats, segmentEdits);
        for (const [position, removed, inserted] of segmentEdits) {
            edits.push([position + offset, removed, inserted]);
        }
        output.push(filtered);
        offset += filtered.length;
    }

    const result = output.join('');
    return {
        text: result,
        stats,
        changed: result !== source,
        edits,
    };
}

export function getRegexExportTerms(settings, options = {}) {
    const {
        language = 'all',
        includeDelete = true,
        includeReplace = false,
        escapeSpecial = true,
    } = options;

    const terms = [];
    const pushTerm = (term, group) => {
        const value = String(term ?? '').trim();
        if (!value) return;
        if (language !== 'all' && group !== language) return;
        terms.push(escapeSpecial ? escapeRegex(value) : value);
    };

    if (includeDelete) {
        for (const rawRule of settings?.deleteRules || []) {
            const rule = normalizeDeleteRule(rawRule);
            pushTerm(rule.text, rule.language);
        }
    }

    if (includeReplace) {
        for (const rawRule of settings?.replaceRules || []) {
            const rule = normalizeReplaceRule(rawRule);
            pushTerm(rule.from, rule.language);
        }
    }

    return [...new Set(terms)];
}
