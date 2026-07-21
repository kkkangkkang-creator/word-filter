import { applyFilterProgram, createEmptyStats, mergeStats } from './filter-engine.js';
import {
    clearVariantBackup,
    getActiveSwipeIndex,
    resolveOriginalVariant,
    storeVariantBackup,
} from './message-backup.js';

export function getAllVariantKeys(message) {
    const keys = ['mes'];
    if (Array.isArray(message?.swipes)) {
        for (let index = 0; index < message.swipes.length; index += 1) {
            keys.push(`swipe:${index}`);
        }
    }
    return keys;
}

export function readVariantText(message, key) {
    if (key === 'mes') return String(message?.mes ?? '');
    const match = /^swipe:(\d+)$/u.exec(String(key));
    if (!match || !Array.isArray(message?.swipes)) return '';
    return String(message.swipes[Number(match[1])] ?? '');
}

export function writeVariantText(message, key, value) {
    const text = String(value ?? '');
    if (key === 'mes') {
        message.mes = text;
        return true;
    }
    const match = /^swipe:(\d+)$/u.exec(String(key));
    if (!match || !Array.isArray(message?.swipes)) return false;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= message.swipes.length) return false;
    message.swipes[index] = text;
    return true;
}

function applyWithMemo(text, program, memo, result) {
    if (!memo) {
        result.evaluatedTexts += 1;
        return applyFilterProgram(text, program);
    }
    if (memo.has(text)) return memo.get(text);
    const filtered = applyFilterProgram(text, program);
    memo.set(text, filtered);
    result.evaluatedTexts += 1;
    return filtered;
}

/**
 * Processes message.mes and every stored swipe.
 *
 * The optional memo is shared by a whole batch. Exact duplicate source strings
 * are filtered once, while each storage field still gets its own reversible
 * backup when required.
 */
export function processMessageVariants(message, program, memo = null) {
    const stats = createEmptyStats();
    const result = {
        changed: false,
        changedVariants: 0,
        matchedVariants: 0,
        scannedVariants: 0,
        evaluatedTexts: 0,
        conflicts: 0,
        stats,
        changedKeys: [],
    };

    const activeSwipe = getActiveSwipeIndex(message);
    const activeKey = activeSwipe === null ? null : `swipe:${activeSwipe}`;
    const mesText = readVariantText(message, 'mes');
    const activeText = activeKey ? readVariantText(message, activeKey) : null;
    const mesBackup = resolveOriginalVariant(message, 'mes');
    const mesMirrorsActive = activeKey !== null && mesText === activeText && !mesBackup.backedUp;
    const keys = getAllVariantKeys(message).filter(key => !(key === 'mes' && mesMirrorsActive));

    // Resolve every original before backup migration mutates legacy metadata.
    const entries = keys.map(key => ({
        key,
        current: readVariantText(message, key),
        original: resolveOriginalVariant(message, key),
    }));

    for (const { key, current, original } of entries) {
        const representedFields = key === activeKey && mesMirrorsActive ? 2 : 1;
        result.scannedVariants += representedFields;
        if (original.conflict) {
            result.conflicts += 1;
            continue;
        }

        const filtered = applyWithMemo(original.text, program, memo, result);
        mergeStats(stats, filtered.stats);
        if (filtered.changed) {
            result.matchedVariants += representedFields;
            storeVariantBackup(message, key, original.text, filtered.text, filtered.edits);
        } else if (original.backedUp) {
            clearVariantBackup(message, key);
        }

        if (current !== filtered.text) {
            writeVariantText(message, key, filtered.text);
            result.changed = true;
            result.changedVariants += representedFields;
            result.changedKeys.push(key);
            if (key === activeKey && mesMirrorsActive) {
                message.mes = filtered.text;
                result.changedKeys.push('mes');
            }
        }
    }

    return result;
}

// Kept as an exported developer helper. The interactive batch path deliberately
// does not call it because a second full pass doubles work on large chats.
export function verifyMessageVariants(message, program) {
    let scannedVariants = 0;
    let mismatches = 0;
    let conflicts = 0;

    for (const key of getAllVariantKeys(message)) {
        scannedVariants += 1;
        const current = readVariantText(message, key);
        const original = resolveOriginalVariant(message, key);
        if (original.conflict) {
            conflicts += 1;
            continue;
        }
        const expected = applyFilterProgram(original.text, program).text;
        if (current !== expected) mismatches += 1;
    }

    return { scannedVariants, mismatches, conflicts };
}
