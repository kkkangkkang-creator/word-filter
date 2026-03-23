// Word Filter Extension for SillyTavern

import { eventSource, event_types, saveSettingsDebounced, updateMessageBlock, messageFormatting, reloadCurrentChat } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const EXT_NAME = 'word-filter';
const FOLDER_PATH = 'scripts/extensions/third-party/word-filter';

const defaultSettings = {
    enabled: true,
    applyToSource: false,
    deleteList: [],
    replaceList: [],
};

function getSettings() {
    const ext = getContext().extensionSettings;
    if (!ext[EXT_NAME]) {
        ext[EXT_NAME] = { ...defaultSettings };
    }
    return ext[EXT_NAME];
}

// ── 필터 엔진 ─────────────────────────────────────────────────────────────────

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makePattern(word) {
    const escaped = escapeRegex(word);
    const hasKorean = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(word);
    if (hasKorean) {
        // 한글: 조사가 붙으므로 경계 없이 포함 검색
        return escaped;
    } else {
        // 영어: 단어 경계
        return `\\b${escaped}\\b`;
    }
}

function applyFilters(text) {
    const s = getSettings();
    if (!s.enabled || !text) return text;
    let result = text;
    for (const rule of s.replaceList) {
        if (!rule.from) continue;
        try { result = result.replace(new RegExp(makePattern(rule.from), 'gi'), rule.to || ''); } catch(e) {}
    }
    for (const word of s.deleteList) {
        if (!word) continue;
        try { result = result.replace(new RegExp(makePattern(word), 'gi'), ''); } catch(e) {}
    }
    return result.replace(/ {2,}/g, ' ');
}

// ── DOM 업데이트 (원본 msg.mes 보존) ──────────────────────────────────────────

function safeUpdateMessage(id, msg) {
    const newText = applyFilters(msg.mes);
    if (newText === msg.mes) return false;

    const s = getSettings();

    if (s.applyToSource) {
        // 원문 반영 ON: msg.mes 수정 + 저장
        msg.mes = newText;
        try {
            if (typeof updateMessageBlock === 'function') {
                updateMessageBlock(id, msg);
            }
        } catch(e) {}
    } else {
        // 원문 반영 OFF: DOM만 업데이트
        try {
            const msgDiv = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (msgDiv && typeof messageFormatting === 'function') {
                msgDiv.innerHTML = messageFormatting(newText, msg.name, !!msg.is_system, !!msg.is_user, id);
            } else if (msgDiv) {
                msgDiv.innerHTML = newText;
            }
        } catch(e) {
            console.error('[Word Filter] Update failed:', e);
        }
    }
    return true;
}

function applyToExistingChat() {
    const s = getSettings();
    if (!s.enabled) return;
    const ctx = getContext();
    const chatList = ctx.chat;
    if (!chatList || !chatList.length) return;
    let changed = false;
    for (let i = 0; i < chatList.length; i++) {
        const msg = chatList[i];
        if (!msg || msg.is_user) continue;
        if (safeUpdateMessage(i, msg)) changed = true;
    }
    if (s.applyToSource && changed) ctx.saveChat();
}

// ── 이벤트 훅 ────────────────────────────────────────────────────────────────

function handleMessageEvent(mesId) {
    if (!getSettings().enabled) return;
    const id = typeof mesId === 'object' ? (mesId.mesId ?? mesId.id) : mesId;
    if (id === undefined) return;

    const ctx = getContext();
    const msg = ctx.chat?.[id];
    if (!msg || msg.is_user) return;

    safeUpdateMessage(id, msg);
}

// ── UI ────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderDeleteList() {
    const s = getSettings();
    const c = document.getElementById('wf-delete-list');
    if (!c) return;
    c.innerHTML = '';
    s.deleteList.forEach((word, idx) => {
        const row = document.createElement('div');
        row.className = 'wf-row';
        row.innerHTML = `<span class="wf-tag">${escapeHtml(word)}</span><button class="wf-btn-remove" data-idx="${idx}">✕</button>`;
        c.appendChild(row);
    });
}

function renderReplaceList() {
    const s = getSettings();
    const c = document.getElementById('wf-replace-list');
    if (!c) return;
    c.innerHTML = '';
    s.replaceList.forEach((rule, idx) => {
        const row = document.createElement('div');
        row.className = 'wf-row';
        row.innerHTML = `<span class="wf-tag">${escapeHtml(rule.from)}</span><span class="wf-arrow">→</span><span class="wf-tag wf-tag--to">${escapeHtml(rule.to || '(삭제)')}</span><button class="wf-btn-remove" data-idx="${idx}">✕</button>`;
        c.appendChild(row);
    });
}

function buildPopupHtml() {
    const s = getSettings();
    return `
    <div id="wf-popup">
        <div class="wf-popup-header">
            <h3>🔤 Word Filter</h3>
            <div class="wf-toggles">
                <label class="wf-toggle-label">활성화
                    <input type="checkbox" id="wf-enabled" ${s.enabled ? 'checked' : ''} />
                </label>
                <label class="wf-toggle-label wf-toggle-source ${s.applyToSource ? 'active' : ''}">원문 반영
                    <input type="checkbox" id="wf-apply-source" ${s.applyToSource ? 'checked' : ''} />
                </label>
            </div>
        </div>
        <div class="wf-tabs">
            <button class="wf-tab active" data-tab="delete">🗑 삭제</button>
            <button class="wf-tab" data-tab="replace">🔁 치환</button>
        </div>
        <div class="wf-tab-content" id="wf-tab-delete">
            <div class="wf-hint" style="margin-bottom:6px;">콤마로 구분해서 여러 개 입력 가능</div>
            <div class="wf-input-col">
                <input type="text" id="wf-delete-input" class="text_pole wf-input" placeholder="mechanical, robotic, automatic" />
                <button id="wf-delete-add" class="menu_button wf-btn-full">추가</button>
            </div>
            <div id="wf-delete-list" class="wf-list"></div>
        </div>
        <div class="wf-tab-content" id="wf-tab-replace" style="display:none;">
            <div class="wf-hint" style="margin-bottom:6px;">바꿀 단어 비우면 삭제</div>
            <div class="wf-input-col">
                <div class="wf-replace-row">
                    <input type="text" id="wf-replace-from" class="text_pole wf-input" placeholder="찾을 단어" />
                    <span class="wf-arrow-label">→</span>
                    <input type="text" id="wf-replace-to" class="text_pole wf-input" placeholder="바꿀 단어" />
                </div>
                <button id="wf-replace-add" class="menu_button wf-btn-full">추가</button>
            </div>
            <div id="wf-replace-list" class="wf-list"></div>
        </div>
    </div>`;
}

function bindPopupEvents() {
    document.querySelectorAll('.wf-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.wf-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.wf-tab-content').forEach(c => c.style.display = 'none');
            tab.classList.add('active');
            document.getElementById('wf-tab-' + tab.dataset.tab).style.display = 'block';
        });
    });

    document.getElementById('wf-enabled')?.addEventListener('change', (e) => {
        getSettings().enabled = e.target.checked;
        saveSettingsDebounced();
        applyToExistingChat();
    });

    document.getElementById('wf-apply-source')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.applyToSource = e.target.checked;
        e.target.closest('.wf-toggle-label')?.classList.toggle('active', s.applyToSource);
        saveSettingsDebounced();
        if (s.applyToSource) applyToExistingChat();
    });

    document.getElementById('wf-delete-add')?.addEventListener('click', () => {
        const input = document.getElementById('wf-delete-input');
        const raw = input.value.trim();
        if (!raw) return;
        const s = getSettings();
        raw.split(',').map(w => w.trim()).filter(Boolean).forEach(w => {
            if (!s.deleteList.includes(w)) s.deleteList.push(w);
        });
        input.value = '';
        saveSettingsDebounced();
        renderDeleteList();
        applyToExistingChat();
    });

    document.getElementById('wf-replace-add')?.addEventListener('click', () => {
        const from = document.getElementById('wf-replace-from').value.trim();
        const to = document.getElementById('wf-replace-to').value.trim();
        if (!from) return;
        const s = getSettings();
        if (!s.replaceList.some(r => r.from === from)) s.replaceList.push({ from, to });
        document.getElementById('wf-replace-from').value = '';
        document.getElementById('wf-replace-to').value = '';
        saveSettingsDebounced();
        renderReplaceList();
        applyToExistingChat();
    });

    document.getElementById('wf-delete-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.wf-btn-remove');
        if (!btn) return;
        getSettings().deleteList.splice(parseInt(btn.dataset.idx), 1);
        saveSettingsDebounced();
        renderDeleteList();
        reloadCurrentChat();
    });

    document.getElementById('wf-replace-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.wf-btn-remove');
        if (!btn) return;
        getSettings().replaceList.splice(parseInt(btn.dataset.idx), 1);
        saveSettingsDebounced();
        renderReplaceList();
        reloadCurrentChat();
    });

    document.getElementById('wf-delete-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('wf-delete-add')?.click();
    });
    document.getElementById('wf-replace-to')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('wf-replace-add')?.click();
    });
}

async function openPopup() {
    const ctx = getContext();
    const promise = ctx.callGenericPopup(buildPopupHtml(), 0);
    setTimeout(() => {
        renderDeleteList();
        renderReplaceList();
        bindPopupEvents();
    }, 50);
    await promise;
}

async function addToWandMenu() {
    try {
        const buttonHtml = await $.get(`${FOLDER_PATH}/button.html`);
        const menu = $('#extensionsMenu');
        if (menu.length > 0) {
            if ($('#word_filter_button').length === 0) {
                menu.append(buttonHtml);
                $('#word_filter_button').on('click', openPopup);
            }
        } else {
            setTimeout(addToWandMenu, 1000);
        }
    } catch(e) {
        console.error('[Word Filter] 버튼 추가 실패:', e);
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

jQuery(async () => {
    getSettings();

    // MESSAGE_RECEIVED는 data 객체를 넘김
    eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
        if (!getSettings().enabled) return;
        const ctx = getContext();
        const chat = ctx.chat;
        if (!chat || !chat.length) return;
        // 마지막 AI 메시지 찾아서 패치
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) {
                setTimeout(() => patchMessage(i), 100);
                break;
            }
        }
    });
    // MESSAGE_SWIPED/UPDATED는 mesId를 넘김
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageEvent);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageEvent);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(applyToExistingChat, 300);
    });

    setTimeout(addToWandMenu, 1000);
    console.log('[Word Filter] Loaded ✓');
});
