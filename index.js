// Word Filter Extension for SillyTavern

(function () {
    const EXT_NAME = 'word-filter';
    const SCRIPT_PREFIX = '__wf__';
    const FOLDER_PATH = 'scripts/extensions/third-party/word-filter';

    const defaultSettings = {
        enabled: true,
        deleteList: [],
        replaceList: [],
    };

    function getCtx() {
        return window.SillyTavern.getContext();
    }

    function getSettings() {
        const ctx = getCtx();
        if (!ctx.extensionSettings[EXT_NAME]) {
            ctx.extensionSettings[EXT_NAME] = { ...defaultSettings };
        }
        return ctx.extensionSettings[EXT_NAME];
    }

    function saveSettings() {
        getCtx().saveSettingsDebounced();
    }

    function reloadChat() {
        getCtx().reloadCurrentChat();
    }

    function makeScript(id, name, findRegex, replaceWith) {
        return {
            id: SCRIPT_PREFIX + id,
            scriptName: name,
            findRegex: findRegex,
            replaceString: replaceWith,
            trimStrings: [],
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        };
    }

    function syncToRegex() {
        const ctx = getCtx();
        const settings = getSettings();

        ctx.extensionSettings.regex = (ctx.extensionSettings.regex || [])
            .filter(s => !s.id?.startsWith(SCRIPT_PREFIX));

        if (!settings.enabled) {
            saveSettings();
            return;
        }

        const newScripts = [];

        settings.deleteList.forEach((word, idx) => {
            if (!word) return;
            newScripts.push(makeScript('del_' + idx, `[WF] 삭제: ${word}`, `/${word}/gi`, ''));
        });

        settings.replaceList.forEach((rule, idx) => {
            if (!rule.from) return;
            newScripts.push(makeScript('rep_' + idx, `[WF] 치환: ${rule.from} → ${rule.to}`, `/${rule.from}/gi`, rule.to || ''));
        });

        ctx.extensionSettings.regex = [...ctx.extensionSettings.regex, ...newScripts];
        saveSettings();
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderDeleteList() {
        const settings = getSettings();
        const container = document.getElementById('wf-delete-list');
        if (!container) return;
        container.innerHTML = '';
        settings.deleteList.forEach((word, idx) => {
            const row = document.createElement('div');
            row.className = 'wf-row';
            row.innerHTML = `<span class="wf-tag">${escapeHtml(word)}</span><button class="wf-btn-remove" data-type="delete" data-idx="${idx}" title="삭제">✕</button>`;
            container.appendChild(row);
        });
    }

    function renderReplaceList() {
        const settings = getSettings();
        const container = document.getElementById('wf-replace-list');
        if (!container) return;
        container.innerHTML = '';
        settings.replaceList.forEach((rule, idx) => {
            const row = document.createElement('div');
            row.className = 'wf-row';
            row.innerHTML = `<span class="wf-tag">${escapeHtml(rule.from)}</span><span class="wf-arrow">→</span><span class="wf-tag wf-tag--to">${escapeHtml(rule.to || '(삭제)')}</span><button class="wf-btn-remove" data-type="replace" data-idx="${idx}" title="삭제">✕</button>`;
            container.appendChild(row);
        });
    }

    function buildPopupHtml() {
        const settings = getSettings();
        return `
        <div id="wf-popup">
            <div class="wf-popup-header">
                <h3>🔤 Word Filter</h3>
                <label class="wf-toggle-label">
                    활성화
                    <input type="checkbox" id="wf-enabled" ${settings.enabled ? 'checked' : ''} />
                </label>
            </div>

            <hr />

            <div class="wf-section">
                <div class="wf-section-label">🗑 삭제할 단어</div>
                <div class="wf-hint">콤마로 구분해서 여러 개 입력 가능</div>
                <div class="wf-input-row">
                    <input type="text" id="wf-delete-input" class="text_pole wf-input" placeholder="mechanical, robotic, automatic" />
                    <button id="wf-delete-add" class="menu_button">추가</button>
                </div>
                <div id="wf-delete-list" class="wf-list"></div>
            </div>

            <hr />

            <div class="wf-section">
                <div class="wf-section-label">🔁 치환 규칙 (A → B)</div>
                <div class="wf-hint">바꿀 단어 비우면 삭제</div>
                <div class="wf-input-row">
                    <input type="text" id="wf-replace-from" class="text_pole wf-input" placeholder="찾을 단어" />
                    <span class="wf-arrow-label">→</span>
                    <input type="text" id="wf-replace-to" class="text_pole wf-input" placeholder="바꿀 단어" />
                    <button id="wf-replace-add" class="menu_button">추가</button>
                </div>
                <div id="wf-replace-list" class="wf-list"></div>
            </div>
        </div>`;
    }

    function bindPopupEvents() {
        const enabledCb = document.getElementById('wf-enabled');
        if (enabledCb) {
            enabledCb.addEventListener('change', (e) => {
                getSettings().enabled = e.target.checked;
                syncToRegex();
                reloadChat();
            });
        }

        document.getElementById('wf-delete-add')?.addEventListener('click', () => {
            const input = document.getElementById('wf-delete-input');
            const raw = input.value.trim();
            if (!raw) return;
            const s = getSettings();
            raw.split(',').map(w => w.trim()).filter(Boolean).forEach(word => {
                if (!s.deleteList.includes(word)) s.deleteList.push(word);
            });
            input.value = '';
            syncToRegex();
            reloadChat();
            renderDeleteList();
        });

        document.getElementById('wf-replace-add')?.addEventListener('click', () => {
            const from = document.getElementById('wf-replace-from').value.trim();
            const to = document.getElementById('wf-replace-to').value.trim();
            if (!from) return;
            const s = getSettings();
            if (!s.replaceList.some(r => r.from === from)) s.replaceList.push({ from, to });
            document.getElementById('wf-replace-from').value = '';
            document.getElementById('wf-replace-to').value = '';
            syncToRegex();
            reloadChat();
            renderReplaceList();
        });

        document.getElementById('wf-delete-list')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.wf-btn-remove');
            if (!btn) return;
            getSettings().deleteList.splice(parseInt(btn.dataset.idx), 1);
            syncToRegex();
            reloadChat();
            renderDeleteList();
        });

        document.getElementById('wf-replace-list')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.wf-btn-remove');
            if (!btn) return;
            getSettings().replaceList.splice(parseInt(btn.dataset.idx), 1);
            syncToRegex();
            reloadChat();
            renderReplaceList();
        });

        document.getElementById('wf-delete-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('wf-delete-add')?.click();
        });
        document.getElementById('wf-replace-to')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('wf-replace-add')?.click();
        });
    }

    async function openPopup() {
        const ctx = getCtx();
        const html = buildPopupHtml();

        // 팝업 HTML을 먼저 DOM에 삽입한 뒤 이벤트 바인딩
        const popupPromise = ctx.callGenericPopup(html, 0);

        // 다음 틱에서 DOM이 준비된 후 바인딩
        setTimeout(() => {
            renderDeleteList();
            renderReplaceList();
            bindPopupEvents();
        }, 50);

        await popupPromise;
    }

    async function addToWandMenu() {
        try {
            const buttonHtml = await $.get(`${FOLDER_PATH}/button.html`);
            const extensionsMenu = $('#extensionsMenu');
            if (extensionsMenu.length > 0) {
                extensionsMenu.append(buttonHtml);
                $('#word_filter_button').on('click', openPopup);
            } else {
                setTimeout(addToWandMenu, 1000);
            }
        } catch (error) {
            console.error('[Word Filter] 버튼 추가 실패:', error);
        }
    }

    async function init() {
        getSettings();
        syncToRegex();
        setTimeout(addToWandMenu, 1000);
        console.log('[Word Filter] Loaded ✓');
    }

    jQuery(init);
})();
