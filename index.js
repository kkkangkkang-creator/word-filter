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
    showNotifications: true,
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
    // 단어 전체가 영숫자 + 밑줄(즉, \w)로만 구성된 경우에만 단어 경계 \b를 붙인다.
    // 그렇지 않으면(@, 공백, 한글 등) 경계를 붙이지 않는다.
    if (/^\w+$/.test(word)) {
        return `\\b${escaped}\\b`;
    } else {
        return escaped;
    }
}

function applyFilters(text) {
    const s = getSettings();
    if (!s.enabled || !text) return { text, stats: null };  // stats 없음
    let result = text;
    const stats = {
        deleted: {},   // { '단어': 삭제된 횟수 }
        replaced: {}   // { 'from단어 -> to단어': 교체 횟수 }
    };

    for (const rule of s.replaceList) {
        if (!rule.from) continue;
        const regex = new RegExp(makePattern(rule.from), 'gi');
        const matches = result.match(regex);
        if (matches) {
            const key = `${rule.from} → ${rule.to || '(삭제)'}`;
            stats.replaced[key] = (stats.replaced[key] || 0) + matches.length;
        }
        result = result.replace(regex, rule.to || '');
    }
    for (const word of s.deleteList) {
        if (!word) continue;
        const regex = new RegExp(makePattern(word), 'gi');
        const matches = result.match(regex);
        if (matches) {
            stats.deleted[word] = (stats.deleted[word] || 0) + matches.length;
        }
        result = result.replace(regex, '');
    }
    result = result.replace(/ {2,}/g, ' ');
    return { text: result, stats };
}

// ── DOM 업데이트 (원본 msg.mes 보존) ──────────────────────────────────────────

function safeUpdateMessage(id, msg) {
    const { text: newText, stats } = applyFilters(msg.mes);
    if (newText === msg.mes) return false;

    const s = getSettings();

    function updateDomDirectly() {
        try {
            const msgElement = document.getElementById(id);
            if (!msgElement) {
                console.warn('[Word Filter] 요소를 찾을 수 없음 (ID: ' + id + ')');
                return;
            }
            if (msgElement.dataset.wordFilterApplied === 'true') return;

            if (typeof messageFormatting === 'function') {
                Promise.resolve(messageFormatting(newText, msg.name, !!msg.is_system, !!msg.is_user, id))
                    .then((html) => {
                        const textDiv = msgElement.querySelector('.mes_text') || msgElement.querySelector('.mes');
                        if (textDiv) {
                            textDiv.innerHTML = html;
                        } else {
                            msgElement.innerHTML = html;
                        }
                        msgElement.dataset.wordFilterApplied = 'true';
                        console.log('[Word Filter] DOM 업데이트 성공 (ID: ' + id + ')');
                    })
                    .catch((e) => console.error('[Word Filter] formatting 실패:', e));
            } else {
                const textDiv = msgElement.querySelector('.mes_text') || msgElement.querySelector('.mes');
                if (textDiv) {
                    textDiv.innerHTML = newText;
                } else {
                    msgElement.innerHTML = newText;
                }
                msgElement.dataset.wordFilterApplied = 'true';
            }
        } catch (e) {
            console.error('[Word Filter] DOM 업데이트 중 오류:', e);
        }
    }

    if (s.applyToSource) {
        msg.mes = newText;
        try {
            if (typeof updateMessageBlock === 'function') {
                updateMessageBlock(id, msg);
            }
        } catch (e) {
            console.warn('[Word Filter] updateMessageBlock 실패:', e);
        }
        setTimeout(() => updateDomDirectly(), 200);
    } else {
        updateDomDirectly();
    }

    // 🎉 여기서 바뀐 내용을 토스트로 알려줍니다.
    if (stats) {
        showFilterToast(stats);
    }

    return true;
}

function showFilterToast(stats) {
    if (!getSettings().showNotifications) return;
    const parts = [];
    const deletedWords = Object.keys(stats.deleted);
    if (deletedWords.length > 0) {
        const totalDeleted = Object.values(stats.deleted).reduce((a, b) => a + b, 0);
        parts.push(`🗑 ${totalDeleted}개 단어 삭제`);
        // 구체적으로 보고 싶다면:
        deletedWords.forEach(w => {
            parts.push(`  · ${w} (${stats.deleted[w]}회)`);
        });
    }
    const replacedKeys = Object.keys(stats.replaced);
    if (replacedKeys.length > 0) {
        const totalReplaced = Object.values(stats.replaced).reduce((a, b) => a + b, 0);
        parts.push(`🔁 ${totalReplaced}개 치환`);
        replacedKeys.forEach(k => {
            parts.push(`  · ${k} (${stats.replaced[k]}회)`);
        });
    }
    const message = parts.join('<br>');
    if (typeof toastr !== 'undefined') {
        toastr.info(message, 'Word Filter', { timeOut: 5000, closeButton: true });
    } else {
        console.log('[Word Filter] 알림:', message.replace(/<br>/g, '\n'));
    }
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
    if (s.applyToSource && changed) {
        try {
            ctx.saveChat();
        } catch (e) {
            console.error('[Word Filter] 채팅 저장 실패:', e);
        }
    }
}

// ── MutationObserver (타이밍 독립적 DOM 감지) ────────────────────────────────

function startObserver() {
    let retryCount = 0;
    const maxRetries = 50;

    function tryObserve() {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            const observer = new MutationObserver((mutations) => {
                if (!getSettings().enabled) return;
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        const mesEl = node.classList?.contains('mes') ? node : node.querySelector?.('.mes');
                        if (!mesEl) continue;
                        const mesId = parseInt(mesEl.getAttribute('mesid'));
                        if (isNaN(mesId)) continue;
                        const ctx = getContext();
                        const msg = ctx.chat?.[mesId];
                        if (!msg || msg.is_user) continue;
                        requestAnimationFrame(() => safeUpdateMessage(mesId, msg));
                    }
                }
            });
            observer.observe(chatEl, { childList: true, subtree: true });
            console.log('[Word Filter] MutationObserver 시작 ✓');
        } else {
            retryCount++;
            if (retryCount <= maxRetries) {
                console.warn(`[Word Filter] #chat 찾기 재시도 (${retryCount}/${maxRetries})`);
                setTimeout(tryObserve, 500);
            } else {
                console.error('[Word Filter] #chat 요소를 찾지 못해 관찰을 포기합니다.');
            }
        }
    }
    tryObserve();
}

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
	  <label class="wf-toggle-label wf-toggle-notify ${s.showNotifications ? 'active' : ''}">🔔 알림
                    <input type="checkbox" id="wf-show-notifications" ${s.showNotifications ? 'checked' : ''} />
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

    document.getElementById('wf-show-notifications')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.showNotifications = e.target.checked;
        e.target.closest('.wf-toggle-label')?.classList.toggle('active', s.showNotifications);
        saveSettingsDebounced();
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
    eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
        setTimeout(() => handleMessageEvent(mesId), 300);
    });
    eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => {
        setTimeout(() => handleMessageEvent(mesId), 300);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(applyToExistingChat, 500);
    });

    startObserver();
    setTimeout(addToWandMenu, 1000);
    console.log('[Word Filter] Loaded ✓');
});
