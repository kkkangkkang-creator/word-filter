export const BACKUP_KEY_V3 = 'word_filter_v3';
export const BACKUP_KEY_V2 = 'word_filter_v2';
export const BACKUP_VERSION = 3;

function hasOwn(object, key) {
    return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

export function hashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function getActiveSwipeIndex(message) {
    const swipeId = Number(message?.swipe_id);
    if (!Array.isArray(message?.swipes)
        || !Number.isInteger(swipeId)
        || swipeId < 0
        || swipeId >= message.swipes.length) {
        return null;
    }
    return swipeId;
}

export function getCurrentVariantKey(message) {
    const swipeId = getActiveSwipeIndex(message);
    return swipeId === null ? 'mes' : `swipe:${swipeId}`;
}

export function getCurrentVariantText(message) {
    const swipeId = getActiveSwipeIndex(message);
    if (swipeId !== null) return String(message.swipes[swipeId] ?? '');
    return String(message?.mes ?? '');
}

export function setCurrentVariant(message, text) {
    const value = String(text ?? '');
    message.mes = value;
    const swipeId = getActiveSwipeIndex(message);
    if (swipeId !== null) message.swipes[swipeId] = value;
}

function ensureExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    return message.extra;
}

export function getBackupStore(message, create = false) {
    if (!message || typeof message !== 'object') return null;
    if (!message.extra && !create) return null;
    const extra = create ? ensureExtra(message) : message.extra;
    if (!extra) return null;

    if (!extra[BACKUP_KEY_V3] && create) {
        extra[BACKUP_KEY_V3] = { version: BACKUP_VERSION, variants: {} };
    }
    const store = extra[BACKUP_KEY_V3] || null;
    if (store && create && (!store.variants || typeof store.variants !== 'object')) store.variants = {};
    return store;
}

function getLegacyStore(message) {
    return message?.extra?.[BACKUP_KEY_V2] || null;
}

function getLegacyOriginal(message, key) {
    const store = getLegacyStore(message);
    if (!store?.variants || typeof store.variants !== 'object') return null;
    if (hasOwn(store.variants, key)) return String(store.variants[key] ?? '');
    if (key !== 'mes' && hasOwn(store.variants, 'mes')) return String(store.variants.mes ?? '');
    return null;
}

function cleanExtra(message) {
    if (!message?.extra) return;
    for (const key of [BACKUP_KEY_V3, BACKUP_KEY_V2]) {
        const store = message.extra[key];
        if (store?.variants && Object.keys(store.variants).length === 0) delete message.extra[key];
    }
    if (Object.keys(message.extra).length === 0) delete message.extra;
}

export function invertPatch(filteredText, operations, { force = false } = {}) {
    let text = String(filteredText ?? '');
    if (!Array.isArray(operations)) return { ok: false, text, reason: 'invalid-patch' };

    for (let index = operations.length - 1; index >= 0; index -= 1) {
        const operation = operations[index];
        if (!Array.isArray(operation) || operation.length < 3) {
            return { ok: false, text, reason: 'invalid-operation' };
        }

        const position = Number(operation[0]);
        const removed = String(operation[1] ?? '');
        const inserted = String(operation[2] ?? '');
        if (!Number.isInteger(position) || position < 0 || position > text.length) {
            return { ok: false, text, reason: 'invalid-position' };
        }

        const actual = text.slice(position, position + inserted.length);
        if (!force && actual !== inserted) {
            return { ok: false, text, reason: 'content-mismatch' };
        }
        text = `${text.slice(0, position)}${removed}${text.slice(position + inserted.length)}`;
    }

    return { ok: true, text };
}

export function createBackupEntry(originalText, filteredText, edits) {
    const original = String(originalText ?? '');
    const filtered = String(filteredText ?? '');
    const patch = {
        m: 'p',
        b: hashText(original),
        r: hashText(filtered),
        o: Array.isArray(edits) ? edits.map(item => [Number(item[0]), String(item[1] ?? ''), String(item[2] ?? '')]) : [],
    };
    const full = {
        m: 'f',
        b: hashText(original),
        r: hashText(filtered),
        t: original,
    };

    // For very short or heavily changed messages, a full copy can actually be smaller.
    return JSON.stringify(patch).length < JSON.stringify(full).length ? patch : full;
}

export function restoreBackupEntry(currentText, entry, { force = false } = {}) {
    const current = String(currentText ?? '');
    if (!entry || typeof entry !== 'object') return { ok: false, text: current, reason: 'missing-entry' };
    if (!force && entry.r && hashText(current) !== entry.r) {
        return { ok: false, text: current, reason: 'result-hash-mismatch' };
    }

    let restored;
    if (entry.m === 'f') {
        restored = String(entry.t ?? '');
    } else if (entry.m === 'p') {
        const result = invertPatch(current, entry.o, { force });
        if (!result.ok) return result;
        restored = result.text;
    } else {
        return { ok: false, text: current, reason: 'unknown-mode' };
    }

    if (!force && entry.b && hashText(restored) !== entry.b) {
        return { ok: false, text: current, reason: 'base-hash-mismatch' };
    }
    return { ok: true, text: restored };
}

export function resolveOriginalVariant(message, key = getCurrentVariantKey(message)) {
    const current = key === 'mes'
        ? String(message?.mes ?? '')
        : String(message?.swipes?.[Number(key.split(':')[1])] ?? '');
    const entry = getBackupStore(message, false)?.variants?.[key];
    if (entry) {
        const restored = restoreBackupEntry(current, entry);
        if (restored.ok) return { text: restored.text, backedUp: true, conflict: false, format: 'v3' };
        return { text: current, backedUp: true, conflict: true, format: 'v3', reason: restored.reason };
    }

    const legacy = getLegacyOriginal(message, key);
    if (legacy !== null) return { text: legacy, backedUp: true, conflict: false, format: 'v2' };
    return { text: current, backedUp: false, conflict: false, format: 'none' };
}

export function storeVariantBackup(message, key, originalText, filteredText, edits) {
    const store = getBackupStore(message, true);
    store.variants[key] = createBackupEntry(originalText, filteredText, edits);

    const legacy = getLegacyStore(message);
    if (legacy?.variants) {
        delete legacy.variants[key];
        if (key !== 'mes' && hasOwn(legacy.variants, 'mes')) delete legacy.variants.mes;
    }
    cleanExtra(message);
    return store.variants[key];
}

export function clearVariantBackup(message, key) {
    const store = getBackupStore(message, false);
    if (store?.variants) delete store.variants[key];
    const legacy = getLegacyStore(message);
    if (legacy?.variants) {
        delete legacy.variants[key];
        if (key !== 'mes') delete legacy.variants.mes;
    }
    cleanExtra(message);
}

function getVariantText(message, key) {
    if (key === 'mes') return String(message?.mes ?? '');
    const match = /^swipe:(\d+)$/u.exec(key);
    if (!match || !Array.isArray(message?.swipes)) return null;
    const index = Number(match[1]);
    if (index < 0 || index >= message.swipes.length) return null;
    return String(message.swipes[index] ?? '');
}

function setVariantText(message, key, value) {
    const text = String(value ?? '');
    if (key === 'mes') {
        message.mes = text;
        return true;
    }
    const match = /^swipe:(\d+)$/u.exec(key);
    if (!match || !Array.isArray(message?.swipes)) return false;
    const index = Number(match[1]);
    if (index < 0 || index >= message.swipes.length) return false;
    message.swipes[index] = text;
    return true;
}

export function restoreMessageBackups(message, { force = false } = {}) {
    if (!message || typeof message !== 'object') return { restored: 0, conflicts: 0, changed: false };
    let restored = 0;
    let conflicts = 0;
    let changed = false;

    const store = getBackupStore(message, false);
    if (store?.variants) {
        const activeSwipe = getActiveSwipeIndex(message);
        const activeSwipeKey = activeSwipe === null ? null : `swipe:${activeSwipe}`;
        const hadMesBackup = hasOwn(store.variants, 'mes');
        let restoredActiveSwipeText = null;

        for (const [key, entry] of Object.entries({ ...store.variants })) {
            const current = getVariantText(message, key);
            if (current === null) continue;
            const result = restoreBackupEntry(current, entry, { force });
            if (!result.ok) {
                conflicts += 1;
                continue;
            }
            if (setVariantText(message, key, result.text)) {
                delete store.variants[key];
                restored += 1;
                changed = changed || current !== result.text;
                if (key === activeSwipeKey) restoredActiveSwipeText = result.text;
            }
        }

        // Older v3 builds stored only the active swipe while changing both swipe and mes.
        // Keep that format restorable, but never overwrite an explicit mes backup.
        if (!hadMesBackup && restoredActiveSwipeText !== null) {
            changed = changed || String(message.mes ?? '') !== restoredActiveSwipeText;
            message.mes = restoredActiveSwipeText;
        }
    }

    const legacy = getLegacyStore(message);
    if (legacy?.variants) {
        for (const [key, value] of Object.entries({ ...legacy.variants })) {
            const original = String(value ?? '');
            const targetKeys = [key];
            const activeSwipe = getActiveSwipeIndex(message);
            if (key === 'mes' && activeSwipe !== null) targetKeys.push(`swipe:${activeSwipe}`);

            let restoredThisEntry = false;
            for (const targetKey of targetKeys) {
                const current = getVariantText(message, targetKey);
                if (current === null) continue;
                if (setVariantText(message, targetKey, original)) {
                    restoredThisEntry = true;
                    changed = changed || current !== original;
                }
            }
            if (restoredThisEntry) {
                delete legacy.variants[key];
                restored += 1;
            }
        }
    }
    cleanExtra(message);
    return { restored, conflicts, changed };
}
