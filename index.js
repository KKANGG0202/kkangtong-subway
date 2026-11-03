// 깡통 노선도 (Kkangtong Subway) - chat & branch organizer for SillyTavern
// v1.0.1

import {
    LOG, TOAST, state, app, ctx, getSettings, save, esc, openChar, loadMap, repairBrokenEntries, bulkSummarize,
    resolveTheme, charByAvatar,
} from './core.js';
import { railSvgHtml, mapHtml, mapClick, mapChange, mapSaveEdit, flatten, mapDragStart, mapDragOver, mapDrop } from './map.js';
import { recentHtml, statsHtml, hubClick, hubInput, hubChange } from './hub.js';
import { ticketHtml, ticketClick, ticketChange, ticketInput, ticketPointerDown, openTicket } from './ticket.js';
import { downloadOne, downloadBot } from './download.js';
import { washHtml, washClick, washChange, hideRange } from './clean.js';
import { relHtml, relClick, relChange } from './rel.js';
import { seriesHtml, seriesClick, seriesInput, seriesChange } from './series.js';
import { twinsHtml, twinsClick, twinsInput } from './twins.js';
import { runCompare, openCompare, makePoster, makeRailPoster, onChatChanged } from './extras.js';

// ---------------------------------------------------------------- shell rendering

const TABS = [
    ['map', '🗺️ 노선도'],
    ['recent', '🌐 최근 탑승'],
    ['stats', '📊 승차 기록'],
    ['series', '🗂️ 시리즈'],
    ['twins', '🎫 중복 검표'],
];

function render() {
    const root = document.getElementById('kts-root');
    if (!root || !state.open) return;
    root.dataset.theme = resolveTheme();
    const pop = root.querySelector('.kts-pop');
    const keep = {};
    for (const sel of ['.kts-list', '.kts-detail', '.kts-hub', '.kts-stats-page', '.kts-tk-list', '.kts-tk-body .col', '.kts-peek', '.kts-list.grouped', '.kts-clean', '.kts-settings-page', '.tw-list', '.se-list', '.kts-rel']) {
        keep[sel] = root.querySelector(sel)?.scrollTop ?? 0;
    }
    const focused = document.activeElement?.id;
    const caret = focused && document.activeElement.selectionStart;

    let body;
    if (state.view === 'ticket') body = ticketHtml();
    else if (state.view === 'settings') body = settingsHtml();
    else if (state.view === 'rel') body = relHtml();
    else if (state.view === 'wash') body = washHtml();
    else if (state.tab === 'recent') body = recentHtml();
    else if (state.tab === 'stats') body = statsHtml();
    else if (state.tab === 'twins') body = twinsHtml();
    else if (state.tab === 'series') body = seriesHtml();
    else body = mapHtml();

    const tabs = state.view !== 'main' ? '' : `<nav class="kts-tabs">${TABS.map(([k, label]) =>
        `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${label}</button>`).join('')}</nav>`;
    pop.innerHTML = `<div class="kts-top">
            <div class="kts-logo"><div class="ic">깡</div><div class="ttl">깡통 노선도</div></div>
            ${tabs}
            <button class="kts-gear ${state.view === 'settings' ? 'on' : ''}" data-act="settings" title="설정">⚙️</button>
            <button class="kts-x" data-act="close" title="닫기">✕</button>
        </div>
        <div class="kts-page">${body}</div>`;

    // the grass scrolls sideways on phones: start at the newest weeks
    const grass = root.querySelector('.kts-grass-wrap');
    if (grass) grass.scrollLeft = grass.scrollWidth;
    for (const [sel, top] of Object.entries(keep)) {
        const el = root.querySelector(sel);
        if (el) el.scrollTop = top;
    }
    if (focused) {
        const el = document.getElementById(focused);
        if (el && el.tagName === 'INPUT' && el.type !== 'checkbox') {
            el.focus();
            try { if (typeof caret === 'number') el.setSelectionRange(caret, caret); } catch { /* number inputs */ }
        }
    }
    if (state.editing) document.getElementById('kts-edit-title')?.focus();
}

async function refresh({ avatar = state.avatar, keepSelection = true } = {}) {
    if (!avatar) {
        const ch = openChar();
        if (!ch) {
            state.avatar = null;
            state.list = [];
            state.error = ctx().groupId ? '그룹챗은 아직 지원하지 않아요. 🌐 최근 탑승 탭에서 다른 봇의 노선도를 볼 수 있어요.' : '캐릭터를 열거나, 🌐 최근 탑승 탭에서 봇을 골라주세요.';
            render();
            return;
        }
        avatar = ch.avatar;
    }
    state.loading = true;
    state.error = '';
    if (avatar !== state.avatar) { state.list = []; state.collapsed.clear(); state.checked.clear(); state.reasons.clear(); state.compare = null; }
    render();
    try {
        await loadMap(avatar);
        const cur = openChar()?.avatar === avatar ? ctx().getCurrentChatId() : null;
        if (!keepSelection || !state.byId.has(state.selectedId)) {
            state.selectedId = state.byId.has(cur) ? cur : (state.roots[0] ?? null);
        }
        for (const id of [...state.checked]) if (!state.byId.has(id)) state.checked.delete(id);
    } catch (err) {
        console.error(LOG, err);
        state.error = '챗 목록을 불러오지 못했어요.';
    }
    state.loading = false;
    render();
}

// ---------------------------------------------------------------- events inside the popup

async function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !document.getElementById('kts-root')?.contains(el)) return;
    const act = el.dataset.act;
    switch (act) {
        case 'close': closePopup(); return;
        case 'settings': state.view = state.view === 'settings' ? 'main' : 'settings'; state.ticket = null; render(); return;
        case 'settings-close': state.view = 'main'; render(); return;
        case 'tab':
            state.tab = el.dataset.v;
            if (state.tab === 'map' && (!state.avatar || state.mapStale)) { state.mapStale = false; refresh(); }
            render();
            return;
        case 'map-home': state.selectedId = null; await refresh({ avatar: openChar()?.avatar, keepSelection: false }); return;
        case 'bulk': await bulkSummarize(); return;
        case 'bulk-stop': if (state.bulk) state.bulk.abort = true; toastr.info('지금 하던 것까지만 하고 멈춰요.'); return;
        case 'poster':
            try {
                // ask which shape: 🚇 horizontal (subway map) or 🌳 vertical (tree), whatever view is on screen
                const c = ctx();
                const r = await c.Popup.show.confirm('🖼️ 노선도 포스터', '어떤 모양으로 저장할까요?', { okButton: '🚇 가로', cancelButton: '🌳 세로' });
                if (r === c.POPUP_RESULT.AFFIRMATIVE) { if (await makeRailPoster(railSvgHtml())) return; }
                else if (r !== c.POPUP_RESULT.NEGATIVE) return;
                await makePoster(flatten({ ignoreView: true }));
            } catch (err) { console.error(LOG, err); toastr.error('포스터를 만들지 못했어요.', TOAST); }
            return;
        case 'ticket': await openTicket(state.selectedId); return;
        case 'hide-range': if (state.selectedId) await hideRange(state.selectedId); return;
        case 'show-range': if (state.selectedId) await hideRange(state.selectedId, state.avatar, { show: true }); return;
        case 'download-one': if (state.selectedId) await downloadOne(state.selectedId); return;
        case 'download-bot':
            if (state.dlBusy) return;
            state.dlBusy = '준비 중…';
            render();
            try { await downloadBot(state.avatar, (d, n) => { state.dlBusy = `${d}/${n}`; render(); }); } finally { state.dlBusy = null; render(); }
            return;
        case 'compare-open': openCompare(state.selectedId); return;
        case 'compare-close': state.compare = null; render(); return;
        case 'compare-run': await runCompare(); return;
    }
    if (await relClick(act, el, ev)) return;
    if (await washClick(act, el, ev)) return;
    if (await ticketClick(act, el, ev)) return;
    if (await twinsClick(act, el, ev)) return;
    if (await seriesClick(act, el, ev)) return;
    if (await hubClick(act, el, ev)) return;
    await mapClick(act, el, ev);
}

function onInput(ev) {
    // Korean/Japanese IME: re-rendering mid-composition splits syllables into jamo (ㅅㅣㅇ…)
    if (ev.isComposing) return;
    if (ev.target.id === 'kts-search') { state.query = ev.target.value; render(); return; }
    if (ticketInput(ev)) return;
    if (twinsInput(ev)) return;
    if (seriesInput(ev)) return;
    hubInput(ev);
}

function onChange(ev) {
    if (settingsChange(ev)) return;
    if (ev.target.id?.startsWith('kts-se-')) { seriesChange(ev); return; }
    if (relChange(ev)) return;
    if (washChange(ev)) return;
    if (ev.target.id === 'kts-compare-target' && state.compare) { state.compare.target = ev.target.value; state.compare.result = null; render(); return; }
    if (ticketChange(ev)) return;
    if (hubChange(ev)) return;
    mapChange(ev);
}

function onKey(ev) {
    if (!state.open) return;
    if (ev.key === 'Escape') {
        if (document.querySelector('dialog.popup[open]')) return;
        if (state.editing) { state.editing = false; render(); return; }
        if (state.view !== 'main') { state.view = 'main'; state.ticket = null; render(); return; }
        closePopup();
    }
    if (state.editing && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) mapSaveEdit();
    if (state.lineEdit && ev.key === 'Enter' && ev.target?.id === 'kts-line-name') document.querySelector('#kts-root [data-act="line-rename-save"]')?.click();
}

// ---------------------------------------------------------------- popup

function openPopup() {
    let root = document.getElementById('kts-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'kts-root';
        root.innerHTML = '<div class="kts-backdrop" data-act="close"></div><div class="kts-pop" role="dialog" aria-label="깡통 노선도"></div>';
        document.body.appendChild(root);
        root.addEventListener('click', onClick);
        root.addEventListener('input', onInput);
        root.addEventListener('compositionend', onInput);
        root.addEventListener('change', onChange);
        root.addEventListener('pointerdown', (ev) => { if (state.view === 'ticket') ticketPointerDown(ev); });
        root.addEventListener('dragstart', mapDragStart);
        root.addEventListener('dragover', mapDragOver);
        root.addEventListener('drop', mapDrop);
        root.addEventListener('dragend', () => document.querySelectorAll('#kts-root .dragging, #kts-root .over').forEach((x) => x.classList.remove('dragging', 'over')));
    }
    root.style.display = '';
    Object.assign(state, { open: true, editing: false, mobileDetail: false, selectMode: false, view: 'main', ticket: null, compare: null, peek: null, tab: 'map' });
    state.checked.clear();
    state.reasons.clear();
    state.selectedId = null;
    refresh({ avatar: openChar()?.avatar || state.avatar, keepSelection: false });
}

function closePopup() {
    state.open = false;
    state.editing = false;
    const root = document.getElementById('kts-root');
    if (root) root.style.display = 'none';
}

Object.assign(app, { render, refresh, openPopup, closePopup });

// ---------------------------------------------------------------- settings panel & entry points

function profileOptions() {
    let profiles = [];
    try { profiles = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { profiles = []; }
    const cur = getSettings().profileId;
    return '<option value="">(지금 쓰는 메인 API)</option>'
        + profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function settingsHtml() {
    const s = getSettings();
    const sel = (v, cur) => (v === cur ? 'selected' : '');
    const num = (id, v, min, max) => `<input id="${id}" class="kts-s-in" type="number" min="${min}" max="${max}" value="${v}">`;
    return `<div class="kts-toolbar"><button class="kts-pill" data-act="settings-close">← 돌아가기</button><span class="kts-cur">⚙️ 설정</span></div>
    <div class="kts-settings-page">
        <section><h4>🧹 정리 기준 <small>폐역 후보 추천 · 정리 센터</small></h4>
            <label>짧은 챗: 메시지 ${num('kts-s-shortmax', s.cleanShortMax, 1, 50)}개 이하</label>
            <label>방치된 챗: ${num('kts-s-staledays', s.cleanStaleDays, 7, 3650)}일 넘게 안 탄, 메시지 ${num('kts-s-stalemax', s.cleanStaleMax, 1, 10000)}개 미만</label>
            <small>그리팅만 있는 챗과 🧪시험운행(직접 붙인 것)은 항상 후보예요. ⭐ · 직접 붙인 🟢 · 🏁 · 분기가 있는 챗 · 지금 열린 챗은 항상 빠져요.</small>
        </section>
        <section><h4>🚦 운행 상태 자동 분류</h4>
            <label class="ck"><input id="kts-s-autostatus" type="checkbox" ${s.autoStatus ? 'checked' : ''}> 태그 안 붙인 역은 자동으로 나누기</label>
            <label>${num('kts-s-autodays', s.autoDays, 1, 365)}일 안에 탔으면 🟢 운행중</label>
            <label>${num('kts-s-restdays', s.restDays, 1, 3650)}일 넘게 안 탔으면 💤 운휴 <small>그 사이는 🟡 정차중</small></label>
            <small>🧪 메시지 3개 이하 · 🏁 종착은 직접만 붙일 수 있어요. 직접 붙인 태그가 항상 우선해요.</small>
        </section>
        <section><h4>🤖 요약</h4>
            <label>요약에 쓸 연결 프로필 <select id="kts-s-profile" class="kts-s-sel">${profileOptions()}</select></label>
            <small>가벼운 모델(플래시 등) 프로필을 추천해요.</small>
            <label>요약할 때 볼 최근 메시지 ${num('kts-s-msgs', s.summaryMessages, 4, 300)}개</label>
            <label>요약 언어 <input id="kts-s-lang" class="kts-s-in wide" type="text" value="${esc(s.outputLanguage)}" placeholder="Korean"></label>
        </section>
        <section><h4>📢 역 안내방송</h4>
            <label>챗을 열 때 지난 줄거리 <select id="kts-s-announce" class="kts-s-sel">
                <option value="away" ${sel('away', s.announce)}>오랜만에 열 때만</option>
                <option value="always" ${sel('always', s.announce)}>항상</option>
                <option value="off" ${sel('off', s.announce)}>끄기</option></select></label>
            <label>"오랜만"의 기준: ${num('kts-s-days', s.announceDays, 1, 3650)}일 넘게 안 탄 챗</label>
        </section>
        <section><h4>🌿 분기 · 🎨 테마</h4>
            <label class="ck"><input id="kts-s-askbranch" type="checkbox" ${s.askBranchName ? 'checked' : ''}> 분기를 만들면 바로 이름 물어보기</label>
            <label>테마 <select id="kts-s-theme" class="kts-s-sel">
                <option value="auto" ${sel('auto', s.theme)}>자동 (실리 테마 밝기 따라감)</option>
                <option value="light" ${sel('light', s.theme)}>라이트</option>
                <option value="dark" ${sel('dark', s.theme)}>다크</option></select></label>
        </section>
        <section><h4>🚪 여는 방법</h4><small>입력창 왼쪽 ☰ 메뉴의 「깡통 노선도」, 또는 <code>/subway</code> · <code>/노선도</code></small></section>
    </div>`;
}

function settingsChange(ev) {
    const t = ev.target;
    if (!t.id?.startsWith('kts-s-')) return false;
    const s = getSettings();
    const clamp = (v, min, max, def) => Math.min(max, Math.max(min, parseInt(v) || def));
    switch (t.id) {
        case 'kts-s-shortmax': s.cleanShortMax = clamp(t.value, 1, 50, 4); break;
        case 'kts-s-staledays': s.cleanStaleDays = clamp(t.value, 7, 3650, 90); break;
        case 'kts-s-stalemax': s.cleanStaleMax = clamp(t.value, 1, 10000, 20); break;
        case 'kts-s-autostatus': s.autoStatus = t.checked; break;
        case 'kts-s-autodays': s.autoDays = clamp(t.value, 1, 365, 14); if (s.restDays < s.autoDays) s.restDays = s.autoDays; break;
        case 'kts-s-restdays': s.restDays = Math.max(s.autoDays || 1, clamp(t.value, 1, 3650, 60)); break;
        case 'kts-s-profile': s.profileId = t.value; break;
        case 'kts-s-msgs': s.summaryMessages = clamp(t.value, 4, 300, 40); break;
        case 'kts-s-lang': s.outputLanguage = t.value.trim() || 'Korean'; break;
        case 'kts-s-announce': s.announce = t.value; break;
        case 'kts-s-days': s.announceDays = clamp(t.value, 1, 3650, 60); break;
        case 'kts-s-askbranch': s.askBranchName = t.checked; break;
        case 'kts-s-theme': s.theme = t.value; break;
        default: return false;
    }
    save();
    render();
    return true;
}

// ☰ menu (left of the chat input), right under "Manage chat files"
function addMenuButton() {
    if (document.getElementById('option_kts_subway')) return;
    const a = document.createElement('a');
    a.id = 'option_kts_subway';
    a.innerHTML = '<i class="fa-lg fa-solid fa-train-subway"></i><span>깡통 노선도</span>';
    a.addEventListener('click', () => {
        const opts = document.getElementById('options');
        if (opts) opts.style.display = 'none';
        openPopup();
    });
    const anchor = document.getElementById('option_select_chat');
    if (anchor) anchor.after(a);
    else document.querySelector('#options .options-content')?.appendChild(a);
}

function addSlashCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'subway',
        aliases: ['노선도'],
        callback: () => { openPopup(); return ''; },
        returns: 'nothing',
        helpString: '<div>깡통 노선도(챗/분기 정리 팝업)를 열어요.</div>',
    }));
}

function bindEvents() {
    const { eventSource, event_types } = ctx();
    const reload = () => { if (state.open && !state.deleting && state.view === 'main' && state.tab === 'map') refresh({ keepSelection: true }); };
    eventSource.on(event_types.CHAT_CHANGED, () => {
        reload();
        onChatChanged();
    });
    eventSource.on(event_types.CHAT_DELETED, reload);
    eventSource.on(event_types.CHAT_RENAMED, (data) => {
        try {
            const avatar = data?.avatarId;
            const from = String(data?.oldFileName ?? '').replace(/\.jsonl$/, '');
            const to = String(data?.newFileName ?? '').replace(/\.jsonl$/, '');
            const all = getSettings().chats;
            if (avatar && from && to && all[avatar]?.[from]) {
                all[avatar][to] = all[avatar][from];
                delete all[avatar][from];
                save();
            }
        } catch (err) { console.warn(LOG, err); }
        reload();
    });
    document.addEventListener('keydown', onKey);
}

(function init() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, () => {
        const s = getSettings();
        // v0.8.0: the station announcement is now opt-in
        // v0.9.3: on by default, but only for chats not opened for a while (counted in days)
        if ((s.announceVer || 0) < 2) { s.announce = 'away'; s.announceDays = 60; delete s.announceHours; s.announceVer = 2; save(); }
        // v0.9.6: 운행중 and 운휴 have separate day counts (🟡 정차중 in between)
        if (!s.statusVer) { s.restDays = Math.max(60, Number(s.autoDays) || 14); if ((Number(s.autoDays) || 14) > 30) s.autoDays = 14; s.statusVer = 1; save(); }
        repairBrokenEntries();
        addMenuButton();
        addSlashCommand();
        bindEvents();
        console.log(LOG, 'loaded v0.7.0');
    });
})();

export { charByAvatar };
