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

function applyWithMemo(text, program, memo) {
    if (!memo) return applyFilterProgram(text, program);
    if (memo.has(text)) return memo.get(text);
    const filtered = applyFilterProgram(text, program);
    memo.set(text, filtered);
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
        conflicts: 0,
        stats,
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
        if (original.conflict) {
            result.conflicts += 1;
            continue;
        }

        const filtered = applyWithMemo(original.text, program, memo);
        mergeStats(stats, filtered.stats);
        if (filtered.changed) {
            storeVariantBackup(message, key, original.text, filtered.text, filtered.edits);
        } else if (original.backedUp) {
            clearVariantBackup(message, key);
        }

        if (current !== filtered.text) {
            writeVariantText(message, key, filtered.text);
            result.changed = true;
            if (key === activeKey && mesMirrorsActive) {
                message.mes = filtered.text;
            }
        }
    }

    return result;
}
