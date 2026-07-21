/**
 * Classifies SillyTavern chat entries without assuming that every extension
 * preserves the native `is_system` flag. Some summarizer extensions mark old
 * turns as system/hidden while keeping the original user/assistant shape.
 */
export function readBooleanFlag(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    return Boolean(value);
}

function hasAssistantSwipeShape(message) {
    if (!Array.isArray(message?.swipes)) return false;
    if (message.swipes.length > 0) return true;
    const swipeId = Number(message?.swipe_id);
    return Number.isInteger(swipeId) && swipeId >= 0;
}

export function classifyChatMessage(message) {
    if (!message || typeof message !== 'object') return 'invalid';

    // Native and summarized user turns retain is_user.
    if (readBooleanFlag(message.is_user)) return 'user';

    const role = String(message.role ?? message.extra?.role ?? '').trim().toLowerCase();
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    if (role === 'system' || role === 'tool') return 'system';

    const isSystem = readBooleanFlag(message.is_system);
    const summarizedHidden = readBooleanFlag(message._summarizedHidden);
    const assistantShape = hasAssistantSwipeShape(message);

    // Narrow compatibility exception: the summarizer used by the reporter sets
    // both flags on old turns. Only hidden non-user turns that still have the
    // assistant swipe structure bypass is_system.
    if (isSystem) {
        if (summarizedHidden && assistantShape) return 'assistant';
        return 'system';
    }

    if (assistantShape) return 'assistant';

    // Hidden non-user entries without a native role are still treated as old
    // assistant turns. User entries were already excluded above.
    if (summarizedHidden) return 'assistant';

    // Native assistant messages normally have both flags false. Missing flags
    // are also treated as assistant for imported/legacy chat compatibility.
    return 'assistant';
}

export function isFilterableMessage(message) {
    return classifyChatMessage(message) === 'assistant';
}
