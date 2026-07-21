import {
    DEFAULT_LANGUAGE_GROUPS,
    applyFilterProgram,
    compileFilterProgram,
    createEmptyStats,
    detectLanguageGroup,
    getRegexExportTerms,
    mergeStats,
    normalizeDeleteRule,
    normalizeReplaceRule,
    splitEntries,
} from './filter-engine.js';
import {
    clearVariantBackup,
    getCurrentVariantKey,
    getCurrentVariantText,
    hashText,
    resolveOriginalVariant,
    restoreMessageBackups,
    setCurrentVariant,
    storeVariantBackup,
} from './message-backup.js';
import {
    getAllVariantKeys,
    processMessageVariants,
    readVariantText,
} from './chat-batch.js';
import { classifyChatMessage, isFilterableMessage } from './message-classifier.js?v=2.3.1';

const EXTENSION_KEY = 'word-filter';
const EXTENSION_PATH = 'third-party/word-filter';
const VERSION = 3;
const DISPLAY_VERSION = '2.3.1';
const TEMPLATE_URL = new URL(`./template.html?v=${DISPLAY_VERSION}`, import.meta.url);

let initialized = false;
let settingsRef = null;
let rulesRevision = 1;
let compiledProgram = null;
let displayCache = new WeakMap();
let sourceStamps = new WeakMap();
let menuRetryTimer = null;
let displayFrame = null;
let displayFlushRunning = false;
let lastOperationResult = null;
let managerOpening = false;
let activeManagerPopup = null;
const queuedDisplayIds = new Set();
const internalRenderIds = new Set();
const eventBindings = [];

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function createId(prefix = 'wf') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function defaultSettings() {
    return {
        version: VERSION,
        enabled: true,
        persistToSource: false,
        showNotifications: false,
        caseSensitive: false,
        collapseSpaces: true,
        deleteRules: [],
        replaceRules: [],
        languageGroups: clone(DEFAULT_LANGUAGE_GROUPS),
        exportOptions: {
            language: 'all',
            includeDelete: true,
            includeReplace: false,
            escapeSpecial: true,
        },
    };
}

function normalizeGroups(groups) {
    const result = [];
    const seen = new Set();
    for (const group of [...DEFAULT_LANGUAGE_GROUPS, ...(Array.isArray(groups) ? groups : [])]) {
        const id = String(group?.id ?? '').trim();
        const name = String(group?.name ?? '').trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, name });
    }
    return result;
}

function migrateSettings(rawSettings) {
    const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const migrated = defaultSettings();
    migrated.enabled = raw.enabled !== false;
    migrated.persistToSource = Boolean(raw.persistToSource ?? raw.applyToSource ?? false);
    migrated.showNotifications = Boolean(raw.showNotifications ?? false);
    migrated.caseSensitive = Boolean(raw.caseSensitive);
    migrated.collapseSpaces = raw.collapseSpaces !== false;
    migrated.languageGroups = normalizeGroups(raw.languageGroups);

    const groupIds = new Set(migrated.languageGroups.map(group => group.id));
    const normalizeLanguage = (language, text) => {
        const detected = language || detectLanguageGroup(text);
        return groupIds.has(detected) ? detected : 'other';
    };

    const sourceDeleteRules = Array.isArray(raw.deleteRules)
        ? raw.deleteRules
        : (Array.isArray(raw.deleteList) ? raw.deleteList : []);
    migrated.deleteRules = sourceDeleteRules
        .map(item => normalizeDeleteRule(item))
        .filter(rule => rule.text)
        .map(rule => ({
            id: rule.id || createId('delete'),
            text: rule.text,
            language: normalizeLanguage(rule.language, rule.text),
        }));

    const sourceReplaceRules = Array.isArray(raw.replaceRules)
        ? raw.replaceRules
        : (Array.isArray(raw.replaceList) ? raw.replaceList : []);
    migrated.replaceRules = sourceReplaceRules
        .map(item => normalizeReplaceRule(item))
        .filter(rule => rule.from)
        .map(rule => ({
            id: rule.id || createId('replace'),
            from: rule.from,
            to: rule.to,
            language: normalizeLanguage(rule.language, rule.from),
        }));

    migrated.exportOptions = {
        ...migrated.exportOptions,
        ...(raw.exportOptions && typeof raw.exportOptions === 'object' ? raw.exportOptions : {}),
    };
    if (migrated.exportOptions.language !== 'all' && !groupIds.has(migrated.exportOptions.language)) {
        migrated.exportOptions.language = 'all';
    }
    return migrated;
}

function getSettings() {
    if (settingsRef) return settingsRef;
    const context = getContext();
    if (!context) throw new Error('SillyTavern context is unavailable.');

    const current = context.extensionSettings[EXTENSION_KEY];
    const valid = current?.version === VERSION
        && Array.isArray(current.deleteRules)
        && Array.isArray(current.replaceRules)
        && Array.isArray(current.languageGroups)
        && current.exportOptions && typeof current.exportOptions === 'object';
    settingsRef = valid ? current : migrateSettings(current);
    context.extensionSettings[EXTENSION_KEY] = settingsRef;
    return settingsRef;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function rebuildProgram() {
    rulesRevision += 1;
    compiledProgram = compileFilterProgram(getSettings());
    displayCache = new WeakMap();
    sourceStamps = new WeakMap();
}

function getProgram() {
    if (!compiledProgram) rebuildProgram();
    return compiledProgram;
}


function resolveMessageId(data, fallbackToLast = false) {
    if (Number.isInteger(data)) return data;
    if (typeof data === 'string' && /^\d+$/u.test(data)) return Number(data);
    if (data && typeof data === 'object') {
        for (const key of ['messageId', 'mesId', 'mesid', 'id', 'index']) {
            const value = data[key];
            if (Number.isInteger(value)) return value;
            if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
        }
    }
    if (fallbackToLast) {
        const chat = getContext()?.chat;
        if (Array.isArray(chat)) {
            for (let index = chat.length - 1; index >= 0; index -= 1) {
                if (isFilterableMessage(chat[index])) return index;
            }
        }
    }
    return null;
}

function getMessageElement(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return null;
    return document.querySelector(`#chat .mes[mesid="${id}"]`);
}

function isEditing(element) {
    return Boolean(element?.querySelector?.(
        'textarea.edit_textarea, .mes_text textarea, .mes_text [contenteditable="true"], .mes_text [contenteditable=""]',
    ));
}

function formatStats(stats) {
    const parts = [];
    if (stats?.totalDeleted) parts.push(`삭제 ${stats.totalDeleted}회`);
    if (stats?.totalReplaced) parts.push(`치환 ${stats.totalReplaced}회`);
    return parts.join(' · ');
}

function notifyStats(stats, title = 'Word Filter') {
    if (!getSettings().showNotifications) return;
    const text = formatStats(stats);
    if (text) globalThis.toastr?.info?.(text, title, { timeOut: 2500, closeButton: true });
}

function filterMessageText(message, source) {
    const program = getProgram();
    const cached = displayCache.get(message);
    if (cached?.revision === rulesRevision && cached.source === source) return cached.result;

    const result = applyFilterProgram(source, program);
    displayCache.set(message, { revision: rulesRevision, source, result });
    return result;
}

function makeDisplayMessage(message, displayText) {
    return {
        ...message,
        extra: {
            ...(message.extra && typeof message.extra === 'object' ? message.extra : {}),
            display_text: displayText,
        },
    };
}

async function updateMessageSafely(messageId, message) {
    const context = getContext();
    if (typeof context?.updateMessageBlock !== 'function') return false;
    internalRenderIds.add(messageId);
    try {
        await Promise.resolve(context.updateMessageBlock(messageId, message));
        return true;
    } finally {
        queueMicrotask(() => internalRenderIds.delete(messageId));
    }
}

async function renderDisplayMessage(messageId, { notify = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled || settings.persistToSource) return false;

    const context = getContext();
    const message = context?.chat?.[messageId];
    const element = getMessageElement(messageId);
    if (!isFilterableMessage(message) || !element || isEditing(element)) return false;

    const currentKey = getCurrentVariantKey(message);
    const resolvedSource = resolveOriginalVariant(message, currentKey);
    const source = resolvedSource.backedUp && !resolvedSource.conflict
        ? resolvedSource.text
        : String(message.mes ?? '');
    const result = filterMessageText(message, source);
    const signature = `${rulesRevision}:${currentKey}:${hashText(source)}:${hashText(result.text)}`;
    if (element.dataset.wordFilterDisplaySignature === signature) return false;

    // A message previously changed in source mode already contains the desired
    // filtered text. Display-only mode must not render an identical overlay for
    // every visible message when that chat is reopened.
    const nativeDisplayText = String(message.mes ?? '');
    if (result.text === nativeDisplayText && !element.dataset.wordFilterDisplaySignature) return false;

    let updated = false;
    if (result.changed) {
        updated = await updateMessageSafely(messageId, makeDisplayMessage(message, result.text));
    } else if (element.dataset.wordFilterDisplaySignature) {
        updated = await updateMessageSafely(messageId, message);
    }
    const currentElement = getMessageElement(messageId);
    if (currentElement) {
        if (result.changed) currentElement.dataset.wordFilterDisplaySignature = signature;
        else delete currentElement.dataset.wordFilterDisplaySignature;
    }

    if (notify && result.changed) notifyStats(result.stats);
    return updated;
}

async function restoreDisplayMessage(messageId) {
    const element = getMessageElement(messageId);
    if (!element?.dataset.wordFilterDisplaySignature || isEditing(element)) return false;
    const message = getContext()?.chat?.[messageId];
    if (!message) return false;
    const updated = await updateMessageSafely(messageId, message);
    const current = getMessageElement(messageId);
    if (current) delete current.dataset.wordFilterDisplaySignature;
    return updated;
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}


function scheduleDisplayFlush() {
    if (displayFrame !== null || displayFlushRunning || queuedDisplayIds.size === 0) return;
    displayFrame = requestAnimationFrame(() => void flushDisplayQueue());
}

async function flushDisplayQueue() {
    displayFrame = null;
    if (displayFlushRunning) return;
    displayFlushRunning = true;
    try {
        while (queuedDisplayIds.size > 0) {
            const ids = [...queuedDisplayIds];
            queuedDisplayIds.clear();
            for (const id of ids) {
                if (getSettings().enabled && !getSettings().persistToSource) await renderDisplayMessage(id);
                else await restoreDisplayMessage(id);
            }
        }
    } finally {
        displayFlushRunning = false;
        scheduleDisplayFlush();
    }
}

function queueDisplayMessage(messageId) {
    if (!Number.isInteger(messageId)) return;
    queuedDisplayIds.add(messageId);
    scheduleDisplayFlush();
}

function scheduleVisibleRefresh() {
    requestAnimationFrame(() => {
        for (const element of document.querySelectorAll('#chat .mes[mesid]')) {
            const id = Number(element.getAttribute('mesid'));
            if (Number.isInteger(id)) queuedDisplayIds.add(id);
        }
        scheduleDisplayFlush();
    });
}

function getSourceStamp(message, key) {
    return sourceStamps.get(message)?.get(key);
}

function setSourceStamp(message, key, text) {
    let map = sourceStamps.get(message);
    if (!map) {
        map = new Map();
        sourceStamps.set(message, map);
    }
    map.set(key, { revision: rulesRevision, hash: hashText(text) });
}

function sourceStampMatches(message, key, text) {
    const stamp = getSourceStamp(message, key);
    return stamp?.revision === rulesRevision && stamp.hash === hashText(text);
}

async function applySourceMessage(messageId, {
    resetOriginal = false,
    notify = false,
    save = false,
    rerender = false,
    repairConflict = true,
} = {}) {
    const settings = getSettings();
    if (!settings.enabled || !settings.persistToSource) return { changed: false, stats: createEmptyStats() };

    const context = getContext();
    const message = context?.chat?.[messageId];
    if (!isFilterableMessage(message)) return { changed: false, stats: createEmptyStats() };

    const key = getCurrentVariantKey(message);
    const currentText = getCurrentVariantText(message);
    if (!resetOriginal && sourceStampMatches(message, key, currentText)) {
        return { changed: false, stats: createEmptyStats(), stamped: true };
    }

    let original;
    let hadBackup = false;
    if (resetOriginal) {
        clearVariantBackup(message, key);
        original = currentText;
    } else {
        const resolved = resolveOriginalVariant(message, key);
        hadBackup = resolved.backedUp;
        if (resolved.conflict && repairConflict) {
            clearVariantBackup(message, key);
            hadBackup = false;
            original = currentText;
        } else if (resolved.conflict) {
            return { changed: false, conflict: true, stats: createEmptyStats() };
        } else {
            original = resolved.text;
        }
    }

    const result = applyFilterProgram(original, getProgram());
    const textChanged = result.text !== currentText;

    if (result.changed) {
        storeVariantBackup(message, key, original, result.text, result.edits);
    } else if (hadBackup || resetOriginal) {
        clearVariantBackup(message, key);
    }
    if (textChanged) setCurrentVariant(message, result.text);

    setSourceStamp(message, key, getCurrentVariantText(message));
    if (!textChanged) return { changed: false, stats: result.stats };

    if (save && typeof context.saveChat === 'function') {
        await Promise.resolve(context.saveChat());
    }
    if (rerender) await updateMessageSafely(messageId, message);
    if (notify) notifyStats(result.stats);
    return { changed: true, stats: result.stats };
}


async function applyToCurrentChat() {
    const context = getContext();
    const settings = getSettings();
    const chat = context?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;
    if (!settings.enabled) return globalThis.toastr?.warning?.('필터를 먼저 활성화하세요.', 'Word Filter');
    if (!getProgram().hasRules) return globalThis.toastr?.info?.('적용할 규칙이 없습니다.', 'Word Filter');

    const messageKinds = chat.reduce((counts, message) => {
        const kind = classifyChatMessage(message);
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
    }, {});
    const aiMessages = messageKinds.assistant ?? 0;
    const userMessages = messageKinds.user ?? 0;
    const systemMessages = messageKinds.system ?? 0;
    const confirmed = await context.Popup.show.confirm(
        `현재 채팅 원문 변경 · v${DISPLAY_VERSION}`,
        `현재 채팅 데이터 ${chat.length}개 중 AI 메시지 ${aiMessages}개를 처리합니다. 화면에 보이는 개수와 관계없이 실제 채팅 데이터의 본문과 저장된 스와이프를 변경하지만, 완료 후 화면 전체를 자동으로 다시 그리지는 않습니다.`,
    );
    if (!confirmed) return;

    const loader = context.loader?.show?.({
        message: '전체 채팅 원문을 변경하는 중…',
        title: 'Word Filter',
        toastMode: 'static',
    });
    const combined = createEmptyStats();
    const filterMemo = new Map();
    let changedMessages = 0;
    let conflicts = 0;

    try {
        const chunkSize = context?.isMobile?.() ? 12 : 40;
        for (let messageId = 0; messageId < chat.length; messageId += 1) {
            const message = chat[messageId];
            if (!isFilterableMessage(message)) continue;

            const result = processMessageVariants(message, getProgram(), filterMemo);
            conflicts += result.conflicts;
            mergeStats(combined, result.stats);
            if (result.changed) changedMessages += 1;

            // Runtime source events only need the active variant stamp. Hashing
            // every historical swipe here adds work without preventing anything.
            const activeKey = getCurrentVariantKey(message);
            setSourceStamp(message, activeKey, getCurrentVariantText(message));

            if (messageId > 0 && messageId % chunkSize === 0) await nextFrame();
        }

        if (changedMessages > 0) await Promise.resolve(context.saveChat?.());

        lastOperationResult = {
            type: 'apply',
            totalMessages: chat.length,
            aiMessages,
            userMessages,
            systemMessages,
            changedMessages,
            conflicts,
            needsScreenRefresh: changedMessages > 0,
        };
        renderOpenManager();

        if (changedMessages > 0) {
            globalThis.toastr?.success?.(
                `${changedMessages}개 AI 메시지의 원문을 저장했습니다. 현재 화면은 채팅을 다시 열거나 “현재 화면 새로고침”을 눌렀을 때 갱신됩니다.`,
                'Word Filter',
                { timeOut: 6000, closeButton: true },
            );
        } else if (conflicts > 0) {
            globalThis.toastr?.warning?.(`변경할 내용이 없고 충돌 ${conflicts}개를 건너뛰었습니다.`, 'Word Filter');
        } else {
            globalThis.toastr?.info?.('변경할 내용이 없습니다.', 'Word Filter');
        }
        notifyStats(combined, 'Word Filter 일괄 적용');
    } finally {
        await loader?.hide?.();
    }
}

async function restoreCurrentChat() {
    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const confirmed = await context.Popup.show.confirm(
        'Word Filter 원문 복원',
        `현재 채팅 데이터 ${chat.length}개의 Word Filter 백업을 검사합니다. 직접 수정된 충돌 항목은 건너뜁니다.`,
    );
    if (!confirmed) return;

    let restoredVariants = 0;
    let conflicts = 0;
    const changedMessageIds = [];
    const chunkSize = context?.isMobile?.() ? 20 : 60;
    for (let index = 0; index < chat.length; index += 1) {
        const result = restoreMessageBackups(chat[index]);
        restoredVariants += result.restored;
        conflicts += result.conflicts;
        if (result.changed) changedMessageIds.push(index);
        if (index > 0 && index % chunkSize === 0) await nextFrame();
    }

    if (restoredVariants === 0) {
        const text = conflicts > 0 ? `복원 충돌 ${conflicts}개가 있어 자동 복원하지 않았습니다.` : '복원할 백업이 없습니다.';
        globalThis.toastr?.info?.(text, 'Word Filter');
        return;
    }

    const settings = getSettings();
    settings.persistToSource = false;
    settings.enabled = false;
    saveSettings();
    rebuildProgram();
    await Promise.resolve(context.saveChat?.());

    lastOperationResult = {
        type: 'restore',
        totalMessages: chat.length,
        changedMessages: changedMessageIds.length,
        restoredVariants,
        conflicts,
        needsScreenRefresh: changedMessageIds.length > 0,
    };
    renderOpenManager();

    globalThis.toastr?.success?.(
        `${changedMessageIds.length}개 메시지, ${restoredVariants}개 항목을 복원하고 필터를 껐습니다.${conflicts ? ` 충돌 ${conflicts}개는 건너뛰었습니다.` : ''}`,
        'Word Filter',
    );
}

async function refreshCurrentChatView() {
    const context = getContext();
    const root = document.querySelector('#wf-app');
    const button = root?.querySelector('#wf-refresh-current-chat');
    if (button) button.disabled = true;
    try {
        if (typeof context?.reloadCurrentChat === 'function') {
            await Promise.resolve(context.reloadCurrentChat());
        } else {
            const visibleIds = [...document.querySelectorAll('#chat .mes[mesid]')]
                .map(element => Number(element.getAttribute('mesid')))
                .filter(Number.isInteger);
            for (const id of visibleIds) {
                const message = context?.chat?.[id];
                if (message) await updateMessageSafely(id, message);
            }
        }
        if (lastOperationResult) lastOperationResult.needsScreenRefresh = false;
        renderOpenManager();
    } finally {
        if (button?.isConnected) button.disabled = false;
    }
}

function downloadText(content, filename, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

async function copyText(value) {
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }
    globalThis.toastr?.success?.('클립보드에 복사했습니다.', 'Word Filter');
}

function resolveLanguage(selected, text) {
    return selected === 'auto' ? detectLanguageGroup(text) : selected;
}

function createLanguageOptions(select, { includeAuto = false, includeAll = false } = {}) {
    select.replaceChildren();
    if (includeAuto) select.add(new Option('자동 분류', 'auto'));
    if (includeAll) select.add(new Option('전체 언어', 'all'));
    for (const group of getSettings().languageGroups) select.add(new Option(group.name, group.id));
}

function makeIconButton(icon, title, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wf-icon-button';
    button.title = title;
    button.disabled = disabled;
    const iconElement = document.createElement('i');
    iconElement.className = `fa-solid ${icon}`;
    button.appendChild(iconElement);
    button.addEventListener('click', action);
    return button;
}

function makeRuleLanguageSelect(rule) {
    const select = document.createElement('select');
    select.className = 'wf-language-badge wf-rule-language-select';
    select.title = '언어 그룹 변경';
    createLanguageOptions(select);
    select.value = rule.language;
    select.addEventListener('change', () => {
        rule.language = select.value;
        saveSettings();
        const root = select.closest('#wf-app');
        if (root) renderExport(root);
    });
    return select;
}

function afterRulesChanged(root) {
    saveSettings();
    rebuildProgram();
    renderManager(root);
    if (!getSettings().persistToSource) scheduleVisibleRefresh();
}

function renderDeleteRules(root) {
    const settings = getSettings();
    const list = root.querySelector('#wf-delete-list');
    const empty = root.querySelector('#wf-delete-empty');
    const query = root.querySelector('#wf-delete-search').value.trim().toLocaleLowerCase();
    const language = root.querySelector('#wf-delete-filter').value;
    const rules = settings.deleteRules.filter(rule =>
        (language === 'all' || rule.language === language)
        && (!query || rule.text.toLocaleLowerCase().includes(query)));

    list.replaceChildren();
    empty.hidden = rules.length > 0;
    for (const rule of rules) {
        const row = document.createElement('div');
        row.className = 'wf-rule-row';
        const text = document.createElement('span');
        text.className = 'wf-rule-text';
        text.textContent = rule.text;
        text.title = rule.text;
        const remove = makeIconButton('fa-xmark', '삭제', () => {
            settings.deleteRules = settings.deleteRules.filter(item => item.id !== rule.id);
            afterRulesChanged(root);
        });
        row.append(makeRuleLanguageSelect(rule), text, remove);
        list.appendChild(row);
    }
    root.querySelector('#wf-delete-count').textContent = `${settings.deleteRules.length}개`;
}

function moveReplaceRule(root, index, delta) {
    const settings = getSettings();
    const target = index + delta;
    if (target < 0 || target >= settings.replaceRules.length) return;
    [settings.replaceRules[index], settings.replaceRules[target]] = [settings.replaceRules[target], settings.replaceRules[index]];
    afterRulesChanged(root);
}

function renderReplaceRules(root) {
    const settings = getSettings();
    const list = root.querySelector('#wf-replace-list');
    const empty = root.querySelector('#wf-replace-empty');
    const query = root.querySelector('#wf-replace-search').value.trim().toLocaleLowerCase();
    const language = root.querySelector('#wf-replace-filter').value;
    const indexedRules = settings.replaceRules.map((rule, index) => ({ rule, index })).filter(({ rule }) => {
        const haystack = `${rule.from} ${rule.to}`.toLocaleLowerCase();
        return (language === 'all' || rule.language === language) && (!query || haystack.includes(query));
    });

    list.replaceChildren();
    empty.hidden = indexedRules.length > 0;
    for (const { rule, index } of indexedRules) {
        const row = document.createElement('div');
        row.className = 'wf-rule-row wf-replace-rule-row';
        const mapping = document.createElement('div');
        mapping.className = 'wf-rule-mapping';
        const from = document.createElement('span');
        from.className = 'wf-rule-text';
        from.textContent = rule.from;
        from.title = rule.from;
        const arrow = document.createElement('i');
        arrow.className = 'fa-solid fa-arrow-right wf-rule-arrow';
        const to = document.createElement('span');
        to.className = 'wf-rule-text wf-rule-text-muted';
        to.textContent = rule.to || '(삭제)';
        to.title = rule.to || '(삭제)';
        mapping.append(from, arrow, to);
        const controls = document.createElement('div');
        controls.className = 'wf-rule-controls';
        controls.append(
            makeIconButton('fa-chevron-up', '위로 이동', () => moveReplaceRule(root, index, -1), index === 0),
            makeIconButton('fa-chevron-down', '아래로 이동', () => moveReplaceRule(root, index, 1), index === settings.replaceRules.length - 1),
            makeIconButton('fa-xmark', '삭제', () => {
                settings.replaceRules = settings.replaceRules.filter(item => item.id !== rule.id);
                afterRulesChanged(root);
            }),
        );
        row.append(makeRuleLanguageSelect(rule), mapping, controls);
        list.appendChild(row);
    }
    root.querySelector('#wf-replace-count').textContent = `${settings.replaceRules.length}개`;
}

function renderExport(root) {
    const terms = getRegexExportTerms(getSettings(), getSettings().exportOptions);
    root.querySelector('#wf-export-output').value = terms.join('|');
    root.querySelector('#wf-export-count').textContent = `${terms.length}개 항목`;
}

function renderGroups(root) {
    const container = root.querySelector('#wf-language-groups');
    container.replaceChildren();
    const defaultIds = new Set(DEFAULT_LANGUAGE_GROUPS.map(group => group.id));
    for (const group of getSettings().languageGroups) {
        const chip = document.createElement('div');
        chip.className = 'wf-group-chip';
        const name = document.createElement('span');
        name.textContent = group.name;
        chip.appendChild(name);
        if (!defaultIds.has(group.id)) {
            chip.appendChild(makeIconButton('fa-xmark', '그룹 삭제', async () => {
                const confirmed = await getContext().Popup.show.confirm(
                    '언어 그룹 삭제',
                    `“${group.name}” 그룹을 삭제하고 해당 규칙을 “기타”로 옮길까요?`,
                );
                if (!confirmed) return;
                const settings = getSettings();
                settings.languageGroups = settings.languageGroups.filter(item => item.id !== group.id);
                for (const rule of settings.deleteRules) if (rule.language === group.id) rule.language = 'other';
                for (const rule of settings.replaceRules) if (rule.language === group.id) rule.language = 'other';
                if (settings.exportOptions.language === group.id) settings.exportOptions.language = 'all';
                saveSettings();
                renderManager(root);
            }));
        }
        container.appendChild(chip);
    }
}

function syncLanguageSelects(root) {
    const values = new Map();
    for (const select of root.querySelectorAll('select[data-wf-language-select]')) values.set(select.id, select.value);
    createLanguageOptions(root.querySelector('#wf-delete-language'), { includeAuto: true });
    createLanguageOptions(root.querySelector('#wf-delete-filter'), { includeAll: true });
    createLanguageOptions(root.querySelector('#wf-replace-language'), { includeAuto: true });
    createLanguageOptions(root.querySelector('#wf-replace-filter'), { includeAll: true });
    createLanguageOptions(root.querySelector('#wf-export-language'), { includeAll: true });
    for (const select of root.querySelectorAll('select[data-wf-language-select]')) {
        const stored = values.get(select.id);
        if (stored && [...select.options].some(option => option.value === stored)) select.value = stored;
    }
    root.querySelector('#wf-export-language').value = getSettings().exportOptions.language;
}

function renderOperationResult(root) {
    const card = root.querySelector('#wf-operation-result');
    const body = root.querySelector('#wf-operation-result-body');
    const refreshButton = root.querySelector('#wf-refresh-current-chat');
    const refreshNote = root.querySelector('#wf-operation-refresh-note');
    if (!card || !body) return;
    if (!lastOperationResult) {
        card.hidden = true;
        body.textContent = '';
        if (refreshButton) refreshButton.hidden = true;
        if (refreshNote) refreshNote.hidden = true;
        return;
    }

    const result = lastOperationResult;
    const lines = result.type === 'apply'
        ? [
            `전체 메시지: ${result.totalMessages}개`,
            `필터 대상 AI 메시지: ${result.aiMessages}개`,
            `변경된 메시지: ${result.changedMessages}개`,
            `사용자·시스템 제외: ${(result.userMessages ?? 0) + (result.systemMessages ?? 0)}개`,
            `충돌로 건너뜀: ${result.conflicts}개`,
        ]
        : [
            `전체 메시지: ${result.totalMessages}개`,
            `복원된 메시지: ${result.changedMessages}개`,
            `복원된 저장 항목: ${result.restoredVariants}개`,
            `충돌로 건너뜀: ${result.conflicts}개`,
        ];
    body.textContent = lines.join('\n');
    if (refreshButton) refreshButton.hidden = !result.needsScreenRefresh;
    if (refreshNote) refreshNote.hidden = !result.needsScreenRefresh;
    card.hidden = false;
}

function renderManager(root) {
    const settings = getSettings();
    root.querySelector('#wf-enabled').checked = settings.enabled;
    root.querySelector('#wf-notifications').checked = settings.showNotifications;
    root.querySelector('#wf-case-sensitive').checked = settings.caseSensitive;
    root.querySelector('#wf-collapse-spaces').checked = settings.collapseSpaces;
    root.querySelector('#wf-persist-source').checked = settings.persistToSource;
    root.classList.toggle('wf-disabled', !settings.enabled);
    root.querySelector('#wf-mode-label').textContent = settings.persistToSource ? '원문 저장 모드' : '표시 전용 모드';
    syncLanguageSelects(root);
    renderDeleteRules(root);
    renderReplaceRules(root);
    renderGroups(root);
    root.querySelector('#wf-export-delete').checked = settings.exportOptions.includeDelete;
    root.querySelector('#wf-export-replace').checked = settings.exportOptions.includeReplace;
    root.querySelector('#wf-export-escape').checked = settings.exportOptions.escapeSpecial;
    renderExport(root);
    renderOperationResult(root);
}

function renderOpenManager() {
    const root = document.querySelector('#wf-app');
    if (root) renderManager(root);
}

function bindTabs(root) {
    for (const button of root.querySelectorAll('.wf-tab')) {
        button.addEventListener('click', () => {
            const target = button.dataset.tab;
            for (const tab of root.querySelectorAll('.wf-tab')) {
                const active = tab === button;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', String(active));
            }
            for (const panel of root.querySelectorAll('.wf-tab-panel')) panel.hidden = panel.dataset.panel !== target;
        });
    }
}

function bindManager(root) {
    bindTabs(root);
    root.querySelector('#wf-enabled').addEventListener('change', event => {
        getSettings().enabled = event.target.checked;
        saveSettings();
        rebuildProgram();
        renderManager(root);
        if (!getSettings().persistToSource || !getSettings().enabled) scheduleVisibleRefresh();
    });
    root.querySelector('#wf-notifications').addEventListener('change', event => {
        getSettings().showNotifications = event.target.checked;
        saveSettings();
    });
    for (const [id, key] of [['wf-case-sensitive', 'caseSensitive'], ['wf-collapse-spaces', 'collapseSpaces']]) {
        root.querySelector(`#${id}`).addEventListener('change', event => {
            getSettings()[key] = event.target.checked;
            saveSettings();
            rebuildProgram();
            if (!getSettings().persistToSource) scheduleVisibleRefresh();
            renderOperationResult(root);
        });
    }
    root.querySelector('#wf-persist-source').addEventListener('change', async event => {
        if (event.target.checked) {
            const confirmed = await getContext().Popup.show.confirm(
                '원문 저장 모드',
                '앞으로 생성·편집·스와이프되는 AI 메시지의 실제 채팅 원문을 변경합니다. 복원 정보는 전체 원문이 아니라 변경 부분 중심으로 저장됩니다.',
            );
            if (!confirmed) {
                event.target.checked = false;
                return;
            }
        }
        getSettings().persistToSource = event.target.checked;
        saveSettings();
        rebuildProgram();
        renderManager(root);
        scheduleVisibleRefresh();
    });

    root.querySelector('#wf-delete-add').addEventListener('click', () => {
        const settings = getSettings();
        const input = root.querySelector('#wf-delete-input');
        const entries = splitEntries(input.value);
        if (!entries.length) return;
        const existing = new Set(settings.deleteRules.map(rule => rule.text.toLocaleLowerCase()));
        for (const text of entries) {
            const key = text.toLocaleLowerCase();
            if (existing.has(key)) continue;
            existing.add(key);
            settings.deleteRules.push({
                id: createId('delete'),
                text,
                language: resolveLanguage(root.querySelector('#wf-delete-language').value, text),
            });
        }
        input.value = '';
        afterRulesChanged(root);
    });
    root.querySelector('#wf-delete-input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            root.querySelector('#wf-delete-add').click();
        }
    });

    root.querySelector('#wf-replace-add').addEventListener('click', () => {
        const settings = getSettings();
        const fromInput = root.querySelector('#wf-replace-from');
        const toInput = root.querySelector('#wf-replace-to');
        const from = fromInput.value.trim();
        if (!from) return;
        if (settings.replaceRules.some(rule => rule.from.toLocaleLowerCase() === from.toLocaleLowerCase())) {
            globalThis.toastr?.warning?.('같은 치환 원문이 이미 있습니다.', 'Word Filter');
            return;
        }
        settings.replaceRules.push({
            id: createId('replace'),
            from,
            to: toInput.value,
            language: resolveLanguage(root.querySelector('#wf-replace-language').value, from),
        });
        fromInput.value = '';
        toInput.value = '';
        afterRulesChanged(root);
    });
    root.querySelector('#wf-replace-to').addEventListener('keydown', event => {
        if (event.key === 'Enter') root.querySelector('#wf-replace-add').click();
    });

    for (const id of ['wf-delete-search', 'wf-delete-filter']) root.querySelector(`#${id}`).addEventListener('input', () => renderDeleteRules(root));
    for (const id of ['wf-replace-search', 'wf-replace-filter']) root.querySelector(`#${id}`).addEventListener('input', () => renderReplaceRules(root));

    const updateExportOptions = () => {
        getSettings().exportOptions = {
            language: root.querySelector('#wf-export-language').value,
            includeDelete: root.querySelector('#wf-export-delete').checked,
            includeReplace: root.querySelector('#wf-export-replace').checked,
            escapeSpecial: root.querySelector('#wf-export-escape').checked,
        };
        saveSettings();
        renderExport(root);
    };
    for (const id of ['wf-export-language', 'wf-export-delete', 'wf-export-replace', 'wf-export-escape']) {
        root.querySelector(`#${id}`).addEventListener('change', updateExportOptions);
    }
    root.querySelector('#wf-export-copy').addEventListener('click', () => {
        const value = root.querySelector('#wf-export-output').value;
        if (value) void copyText(value);
        else globalThis.toastr?.info?.('내보낼 항목이 없습니다.', 'Word Filter');
    });
    root.querySelector('#wf-export-download').addEventListener('click', () => {
        const value = root.querySelector('#wf-export-output').value;
        if (!value) return globalThis.toastr?.info?.('내보낼 항목이 없습니다.', 'Word Filter');
        downloadText(value, `word-filter-${getSettings().exportOptions.language}-regex.txt`);
    });

    root.querySelector('#wf-group-add').addEventListener('click', () => {
        const input = root.querySelector('#wf-group-name');
        const name = input.value.trim();
        if (!name) return;
        const settings = getSettings();
        if (settings.languageGroups.some(group => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            return globalThis.toastr?.warning?.('같은 이름의 그룹이 이미 있습니다.', 'Word Filter');
        }
        settings.languageGroups.push({ id: createId('lang'), name });
        input.value = '';
        saveSettings();
        renderManager(root);
    });

    root.querySelector('#wf-json-export').addEventListener('click', () => {
        const payload = {
            format: 'word-filter-backup',
            version: VERSION,
            exportedAt: new Date().toISOString(),
            settings: getSettings(),
        };
        downloadText(JSON.stringify(payload, null, 2), 'word-filter-backup.json', 'application/json;charset=utf-8');
    });
    root.querySelector('#wf-json-import').addEventListener('click', () => root.querySelector('#wf-json-file').click());
    root.querySelector('#wf-json-file').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            settingsRef = migrateSettings(parsed.settings ?? parsed);
            getContext().extensionSettings[EXTENSION_KEY] = settingsRef;
            saveSettings();
            rebuildProgram();
            renderManager(root);
            scheduleVisibleRefresh();
            globalThis.toastr?.success?.('백업을 가져왔습니다.', 'Word Filter');
        } catch (error) {
            console.error('[Word Filter] 백업 가져오기 실패:', error);
            globalThis.toastr?.error?.('올바른 Word Filter 백업 파일이 아닙니다.', 'Word Filter');
        }
    });

    root.querySelector('#wf-apply-current-chat').addEventListener('click', () => void applyToCurrentChat());
    root.querySelector('#wf-restore-current-chat').addEventListener('click', () => void restoreCurrentChat());
    root.querySelector('#wf-refresh-current-chat')?.addEventListener('click', () => void refreshCurrentChatView());
}

async function loadManagerTemplate(context) {
    try {
        const response = await fetch(TEMPLATE_URL.href, {
            cache: 'no-store',
            credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (!html.includes('id="wf-app"')) throw new Error('Word Filter root missing');
        return html;
    } catch (error) {
        console.warn('[Word Filter] 버전 지정 템플릿 로드 실패, SillyTavern 템플릿 로더로 재시도:', error);
        return await context.renderExtensionTemplateAsync(EXTENSION_PATH, 'template');
    }
}

function validateManagerRoot(root) {
    const requiredIds = [
        'wf-enabled',
        'wf-delete-input',
        'wf-delete-add',
        'wf-replace-from',
        'wf-replace-to',
        'wf-replace-add',
        'wf-export-output',
        'wf-apply-current-chat',
        'wf-restore-current-chat',
    ];
    const missing = requiredIds.filter(id => !root.querySelector(`#${id}`));
    if (missing.length > 0) {
        throw new Error(`관리 화면 요소 누락: ${missing.join(', ')}. 이전 템플릿 캐시가 남아 있을 수 있습니다.`);
    }
}

async function openManager() {
    if (managerOpening || activeManagerPopup?.dlg?.isConnected) return;
    managerOpening = true;
    const context = getContext();
    try {
        if (!context?.Popup || !context?.POPUP_TYPE) throw new Error('Popup API를 사용할 수 없습니다.');
        const html = await loadManagerTemplate(context);
        const popup = new context.Popup(html, context.POPUP_TYPE.TEXT, '', {
            large: true,
            okButton: '닫기',
            allowVerticalScrolling: true,
            leftAlign: true,
            animation: 'fast',
            onClose: () => {
                if (activeManagerPopup === popup) activeManagerPopup = null;
            },
        });
        activeManagerPopup = popup;
        popup.dlg.classList.add('wf-dialog');
        const root = popup.content.querySelector('#wf-app');
        if (!root) throw new Error('Word Filter 관리 화면을 찾지 못했습니다. 이전 파일 또는 캐시가 남아 있을 수 있습니다.');
        validateManagerRoot(root);
        bindManager(root);
        renderManager(root);
        managerOpening = false;
        await popup.show();
    } catch (error) {
        activeManagerPopup = null;
        throw error;
    } finally {
        managerOpening = false;
    }
}

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('word_filter_button')) return false;
    const button = document.createElement('div');
    button.id = 'word_filter_button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.title = 'Word Filter';
    button.innerHTML = '<i class="fa-solid fa-filter"></i><span>Word Filter</span>';
    const open = event => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        requestAnimationFrame(() => void openManager().catch(error => {
            console.error('[Word Filter] 관리 화면 열기 실패:', error);
            globalThis.toastr?.error?.(`Word Filter 화면을 열지 못했습니다: ${error.message}`, 'Word Filter', { timeOut: 6000, closeButton: true });
        }));
    };
    button.addEventListener('click', open);
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(event);
        }
    });
    menu.appendChild(button);
    return true;
}

function bindEvent(eventName, handler) {
    const context = getContext();
    const events = context?.eventTypes || context?.event_types;
    const eventType = events?.[eventName];
    if (!eventType || !context?.eventSource) return;
    context.eventSource.on(eventType, handler);
    eventBindings.push([eventType, handler]);
}

function registerEvents() {
    bindEvent('MESSAGE_RECEIVED', async data => {
        if (!getSettings().enabled || !getSettings().persistToSource) return;
        const id = resolveMessageId(data, true);
        if (id === null || internalRenderIds.has(id)) return;
        await applySourceMessage(id, { notify: true, save: false, rerender: false });
    });

    bindEvent('CHARACTER_MESSAGE_RENDERED', data => {
        if (!getSettings().enabled || getSettings().persistToSource) return;
        const id = resolveMessageId(data, true);
        if (id === null || internalRenderIds.has(id)) return;
        // In source mode MESSAGE_RECEIVED / MESSAGE_EDITED already changed the
        // data before SillyTavern rendered it. Reprocessing here caused a second
        // save and a second full Markdown render for every new response.
        queueDisplayMessage(id);
    });

    bindEvent('MESSAGE_EDITED', async data => {
        const id = resolveMessageId(data, false);
        if (id === null || internalRenderIds.has(id)) return;
        if (getSettings().persistToSource) {
            await applySourceMessage(id, { resetOriginal: true, notify: false, save: false, rerender: false });
        } else {
            requestAnimationFrame(() => queueDisplayMessage(id));
        }
    });

    bindEvent('MESSAGE_SWIPED', async data => {
        const id = resolveMessageId(data, true);
        if (id === null || internalRenderIds.has(id)) return;
        if (getSettings().persistToSource) {
            await applySourceMessage(id, { notify: true, save: true, rerender: true });
        } else {
            requestAnimationFrame(() => queueDisplayMessage(id));
        }
    });

    const refreshDisplayOnly = () => {
        if (getSettings().enabled && !getSettings().persistToSource) scheduleVisibleRefresh();
    };
    bindEvent('CHAT_CHANGED', refreshDisplayOnly);
    bindEvent('MORE_MESSAGES_LOADED', refreshDisplayOnly);
    bindEvent('MESSAGE_DELETED', refreshDisplayOnly);
}

function cleanup() {
    queuedDisplayIds.clear();
    if (displayFrame !== null) cancelAnimationFrame(displayFrame);
    displayFrame = null;
    displayFlushRunning = false;
    if (menuRetryTimer) clearInterval(menuRetryTimer);
    menuRetryTimer = null;
    const context = getContext();
    for (const [eventType, handler] of eventBindings.splice(0)) {
        context?.eventSource?.removeListener?.(eventType, handler);
    }
    document.getElementById('word_filter_button')?.remove();
    activeManagerPopup = null;
    managerOpening = false;
    initialized = false;
}

async function initialize() {
    if (initialized) return;
    initialized = true;
    try {
        getSettings();
        rebuildProgram();
        saveSettings();
        registerEvents();
        if (!addMenuButton()) {
            menuRetryTimer = setInterval(() => {
                if (addMenuButton()) {
                    clearInterval(menuRetryTimer);
                    menuRetryTimer = null;
                }
            }, 500);
            setTimeout(() => {
                if (menuRetryTimer) clearInterval(menuRetryTimer);
                menuRetryTimer = null;
            }, 10000);
        }
        if (getSettings().enabled && !getSettings().persistToSource) scheduleVisibleRefresh();
        console.info(`[Word Filter] Loaded v${DISPLAY_VERSION}. Source mode idle path enabled.`);
    } catch (error) {
        initialized = false;
        console.error('[Word Filter] 초기화 실패:', error);
        globalThis.toastr?.error?.('Word Filter를 초기화하지 못했습니다. 콘솔을 확인하세요.');
    }
}

export function onEnable() {
    void initialize();
}

export function onDisable() {
    cleanup();
}

export function onClean() {
    cleanup();
}

function boot() {
    const context = getContext();
    const events = context?.eventTypes || context?.event_types;
    if (context?.eventSource && events?.APP_READY) {
        const handler = () => void initialize();
        context.eventSource.on(events.APP_READY, handler);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
    } else {
        void initialize();
    }
}

boot();
