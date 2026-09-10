export const DEFAULT_LANGUAGE_GROUPS = Object.freeze([
    { id: 'ko', name: '한국어' },
    { id: 'en', name: 'English' },
    { id: 'ja', name: '日本語' },
    { id: 'zh', name: '中文' },
    { id: 'other', name: '기타' },
]);

export function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    return {
        id: String(rule?.id ?? ''),
        text: String(rule?.text ?? rule?.word ?? '').trim(),
        language: String(rule?.language ?? fallbackLanguage),
    };
}

export function normalizeReplaceRule(rule, fallbackLanguage = 'other') {
    return {
        id: String(rule?.id ?? ''),
        from: String(rule?.from ?? '').trim(),
        to: String(rule?.to ?? ''),
        language: String(rule?.language ?? detectLanguageGroup(rule?.from) ?? fallbackLanguage),
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

    const allPatterns = [...replaceRules, ...deleteRules].map(rule => `(?:${rule.pattern})`);
    const quickRegex = allPatterns.length
        ? new RegExp(allPatterns.join('|'), caseSensitive ? 'u' : 'iu')
        : null;
    return Object.freeze({
        enabled: settings?.enabled !== false,
        collapseSpaces: settings?.collapseSpaces !== false,
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

function collapseSpacesWithEdits(input, edits) {
    const rule = {
        regex: /[ \t]{2,}/gu,
    };
    return replaceWithEdits(input, rule, ' ', edits);
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
    const hasCollapsibleSpaces = program.collapseSpaces && /[ \t]{2,}/u.test(source);
    if (!hasRuleMatch && !hasCollapsibleSpaces) {
        return { text: source, stats: createEmptyStats(), changed: false, edits: [] };
    }

    let result = source;
    const stats = createEmptyStats();
    const edits = [];

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
