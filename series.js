// 깡통 노선도 - "🗂️ 시리즈" tab: sort hundreds of bots into your own series
// - pick many bots at once from one searchable list (no opening each card)
// - or let keywords find candidates (해리포터, 호그와트 …) and confirm them
// Series live in this extension; optionally they are mirrored as ST character tags.

import { LOG, TOAST, LINE_COLORS, state, app, ctx, esc, cut, avatarUrl, getSettings, save, charByAvatar, fmtAgo } from './core.js';
import { loadHub } from './hub.js';

const PAGE = 120;

const ser = () => state.series || (state.series = { filter: 'all', query: '', sel: new Set(), view: 'list', page: 1, find: null });
const allSeries = () => {
    const s = getSettings();
    if (!Array.isArray(s.series)) s.series = [];
    return s.series;
};
const seriesById = (id) => allSeries().find((x) => x.id === id);
const seriesOf = (avatar) => allSeries().filter((x) => x.members.includes(avatar));
const chars = () => (ctx().characters || []).filter((c) => c?.avatar);
const norm = (t) => String(t ?? '').toLowerCase().normalize('NFKC');

function newId() {
    try { return crypto.randomUUID(); } catch { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

// ---------------------------------------------------------------- ST tags (optional mirror)

async function tagsApi() {
    try { return await import('/scripts/tags.js'); } catch (err) { console.warn(LOG, 'tags.js import failed', err); return null; }
}

/** Find or create the ST tag for a series, then put every member under it. */
async function syncTag(sr) {
    const api = await tagsApi();
    if (!api?.tags || !api.addTagsToEntity) { toastr.error('실리 태그 기능을 찾지 못했어요.', TOAST); return false; }
    let tag = api.tags.find((t) => t.id === sr.tagId) || api.tags.find((t) => t.name === sr.name);
    if (!tag) {
        tag = {
            id: newId(), name: sr.name, folder_type: 'NONE', filter_state: 'UNDEFINED',
            sort_order: Math.max(0, ...api.tags.map((t) => t.sort_order || 0)) + 1,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
        };
        api.tags.push(tag);
    }
    sr.tagId = tag.id;
    if (sr.members.length) api.addTagsToEntity(tag, sr.members.filter((a) => charByAvatar(a)));
    try { api.printTagFilters?.(); } catch { /* list redraws on its own later */ }
    ctx().saveSettingsDebounced?.();
    return true;
}

async function untag(sr, avatars) {
    if (!sr.syncTag || !sr.tagId || !avatars.length) return;
    const api = await tagsApi();
    const tag = api?.tags?.find((t) => t.id === sr.tagId);
    if (tag && api.removeTagFromEntity) api.removeTagFromEntity(tag, avatars);
}

// ---------------------------------------------------------------- membership

async function addTo(sr, avatars) {
    const before = new Set(sr.members);
    const added = avatars.filter((a) => !before.has(a));
    sr.members.push(...added);
    save();
    if (sr.syncTag && added.length) await syncTag(sr);
    return added.length;
}

async function removeFrom(sr, avatars) {
    const drop = new Set(avatars);
    const gone = sr.members.filter((a) => drop.has(a));
    sr.members = sr.members.filter((a) => !drop.has(a));
    save();
    await untag(sr, gone);
    return gone.length;
}

// ---------------------------------------------------------------- keyword finder

const FIELDS = [
    ['name', '이름'], ['description', '설명'], ['personality', '성격'], ['scenario', '시나리오'],
    ['first_mes', '첫 메시지'], ['mes_example', '예시'], ['creator_notes', '메모'], ['system_prompt', '시스템'],
];

function fieldText(c, key) {
    const v = c?.data?.[key] ?? c?.[key];
    return typeof v === 'string' ? v : '';
}

async function fullCard(ch) {
    if (!ch.shallow && ch.data) return ch;
    try {
        const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: ch.avatar }) });
        return res.ok ? await res.json() : ch;
    } catch { return ch; }
}

function countIn(text, word) {
    if (!word) return 0;
    let n = 0;
    let i = 0;
    for (;;) { i = text.indexOf(word, i); if (i < 0) return n; n++; i += word.length; }
}

const splitWords = (t) => String(t || '').split(/[,，\n]/).map((x) => norm(x).trim()).filter(Boolean);

async function runFind() {
    const f = ser().find;
    const sr = seriesById(f.seriesId);
    if (!sr) return;
    const words = splitWords(f.keywords);
    const excl = splitWords(f.exclude);
    if (!words.length) { toastr.info('찾을 키워드를 적어주세요.', TOAST); return; }
    sr.keywords = f.keywords; sr.exclude = f.exclude; sr.minHits = f.minHits;
    save();
    f.busy = true;
    app.render();
    const out = [];
    for (const ch of chars()) {
        if (sr.members.includes(ch.avatar)) continue;
        const c = await fullCard(ch);
        const extra = [...(c.data?.alternate_greetings || []), (c.data?.extensions?.world || ''), ...(c.tags || c.data?.tags || [])].join('\n');
        const where = [];
        let total = 0;
        let blocked = false;
        for (const [key, label] of [...FIELDS, ['extra', '기타']]) {
            const text = norm(key === 'extra' ? extra : fieldText(c, key));
            if (!text) continue;
            if (excl.some((w) => text.includes(w))) { blocked = true; break; }
            const n = words.reduce((sum, w) => sum + countIn(text, w), 0);
            if (n) { where.push(`${label} ${n}`); total += n; }
        }
        if (blocked || !total) continue;
        out.push({ avatar: ch.avatar, total, where: where.join(' · ') });
    }
    out.sort((a, b) => b.total - a.total);
    f.results = out;
    f.pick = new Set(out.filter((r) => r.total >= (Number(f.minHits) || 1)).map((r) => r.avatar));
    f.busy = false;
    app.render();
}

// ---------------------------------------------------------------- rendering

function botMeta(avatar) {
    const bot = state.hub?.bots?.find((b) => b.avatar === avatar);
    return bot ? `역 ${bot.chats} · ${fmtAgo(bot.last)}` : '챗 없음';
}

function badge(sr) {
    return `<span class="se-badge" style="--c:${sr.color}">${esc(cut(sr.name, 12))}</span>`;
}

function findHtml() {
    const st = ser();
    const f = st.find;
    const sr = seriesById(f.seriesId);
    if (!sr) { st.view = 'list'; return listHtml(); }
    const rows = (f.results || []).map((r) => {
        const c = charByAvatar(r.avatar)?.char || {};
        const on = f.pick.has(r.avatar);
        return `<div class="se-row ${on ? 'on' : ''}" data-act="se-find-pick" data-avatar="${esc(r.avatar)}">
            <span class="kts-ck ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
            <img src="${esc(avatarUrl(r.avatar))}" alt="" loading="lazy">
            <div class="info"><b>${esc(cut(c.name || r.avatar, 28))}</b><small>🔎 ${r.total}번 · ${esc(r.where)}</small></div>
            <div class="bdg">${seriesOf(r.avatar).map(badge).join('')}</div>
        </div>`;
    }).join('');
    return `<div class="kts-toolbar"><button class="kts-pill" data-act="se-find-close">← 돌아가기</button><span class="kts-cur">🔍 키워드로 찾기<small>${esc(sr.name)}</small></span></div>
    <div class="se-find">
        <label>찾을 말 <input id="kts-se-kw" class="kts-search small" value="${esc(f.keywords)}" placeholder="해리포터, 호그와트, Harry Potter"></label>
        <label>이 말이 있으면 빼기 <input id="kts-se-ex" class="kts-search small" value="${esc(f.exclude)}" placeholder="패러디, AU (비워둬도 돼요)"></label>
        <label class="row">합쳐서 <input id="kts-se-min" class="kts-s-in" type="number" min="1" max="99" value="${Number(f.minHits) || 1}"> 번 이상 나오면 미리 체크 <button class="kts-b p" data-act="se-find-run" ${f.busy ? 'disabled' : ''}>${f.busy ? '찾는 중…' : '🔍 찾기'}</button></label>
        <small>이름·설명·성격·시나리오·첫 메시지·예시·메모·추가 인사말·연결된 월드인포 이름에서 찾아요. 쉼표로 여러 개 적을 수 있어요.</small>
    </div>
    ${f.results ? `<div class="se-list">${rows || '<div class="kts-empty">맞는 봇이 없어요.</div>'}</div>
    <div class="kts-foot"><span>후보 ${f.results.length}명 중 ${f.pick.size}명 체크</span>
        <button class="kts-b" data-act="se-find-all">${f.pick.size === f.results.length ? '전부 해제' : '전부 체크'}</button>
        <button class="kts-b p" data-act="se-find-add" ${f.pick.size ? '' : 'disabled'}>🗂️ ${f.pick.size}명 넣기</button></div>` : ''}`;
}

function listHtml() {
    const st = ser();
    const list = allSeries();
    const all = chars();
    const inAny = new Set(list.flatMap((x) => x.members));
    const q = norm(st.query).trim();
    let bots = all;
    if (st.filter === 'none') bots = bots.filter((c) => !inAny.has(c.avatar));
    else if (st.filter !== 'all') { const sr = seriesById(st.filter); bots = sr ? bots.filter((c) => sr.members.includes(c.avatar)) : bots; }
    if (q) bots = bots.filter((c) => norm(c.name).includes(q));
    bots = [...bots].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    const shown = bots.slice(0, PAGE * st.page);
    const cur = st.filter !== 'all' && st.filter !== 'none' ? seriesById(st.filter) : null;

    const chip = (k, label, color) => `<button class="kts-pill se-chip ${st.filter === k ? 'on' : ''}" data-act="se-filter" data-v="${esc(k)}" ${color ? `style="--c:${color}"` : ''}>${label}</button>`;
    const chips = [
        chip('all', `전체 ${all.length}`),
        chip('none', `미분류 ${all.filter((c) => !inAny.has(c.avatar)).length}`),
        ...list.map((x) => chip(x.id, `<i style="background:${x.color}"></i>${esc(cut(x.name, 14))} ${x.members.filter((a) => charByAvatar(a)).length}`, x.color)),
        '<button class="kts-pill se-chip add" data-act="se-new">＋ 새 시리즈</button>',
    ].join('');

    const head = cur ? `<div class="se-head" style="--c:${cur.color}">
        <b>${esc(cur.name)}</b><small>${cur.members.length}명</small>
        <span class="sp"></span>
        <button class="kts-b" data-act="se-find" title="키워드로 이 시리즈에 넣을 봇을 찾아요">🔍 키워드로 찾기</button>
        <label class="ck" title="이 시리즈를 실리 캐릭터 태그로도 붙여서, 실리 캐릭터 목록 필터에서도 쓸 수 있어요"><input type="checkbox" id="kts-se-tag" ${cur.syncTag ? 'checked' : ''}> 🏷️ 실리 태그로도</label>
        <button class="kts-b" data-act="se-rename">이름 바꾸기</button>
        <button class="kts-b d" data-act="se-delete">시리즈 없애기</button>
    </div>` : '';

    const rows = shown.map((c) => {
        const on = st.sel.has(c.avatar);
        return `<div class="se-row ${on ? 'on' : ''}" data-act="se-pick" data-avatar="${esc(c.avatar)}">
            <span class="kts-ck ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
            <img src="${esc(avatarUrl(c.avatar))}" alt="" loading="lazy">
            <div class="info"><b>${esc(cut(c.name, 30))}</b><small>${esc(botMeta(c.avatar))}</small></div>
            <div class="bdg">${seriesOf(c.avatar).map(badge).join('')}</div>
            <button class="kts-b mini" data-act="hub-map" data-avatar="${esc(c.avatar)}" title="이 봇의 노선도">🗺️</button>
        </div>`;
    }).join('');

    const visibleAll = shown.length && shown.every((c) => st.sel.has(c.avatar));
    const opts = list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    const foot = st.sel.size ? `<div class="kts-foot se-foot"><span>${st.sel.size}명 골랐어요</span>
        <select id="kts-se-target" class="kts-pill"><option value="">🗂️ 시리즈에 넣기…</option>${opts}<option value="__new">＋ 새 시리즈 만들어서 넣기</option></select>
        ${cur ? `<button class="kts-b d" data-act="se-remove">「${esc(cut(cur.name, 8))}」에서 빼기</button>` : ''}
        <button class="kts-b" data-act="se-clear">선택 해제</button></div>` : '';

    return `<div class="kts-toolbar">
        <span class="kts-cur">🗂️ 시리즈<small>${list.length}개</small></span>
        <input id="kts-se-search" class="kts-search" type="search" placeholder="봇 이름으로 찾기" value="${esc(st.query)}">
        <button class="kts-pill" data-act="se-visible">${visibleAll ? '보이는 것 해제' : `보이는 ${shown.length}명 전부 선택`}</button>
    </div>
    <div class="se-chips">${chips}</div>
    ${head}
    ${list.length ? '' : '<div class="tw-hint">＋ 새 시리즈로 묶음을 만들고, 아래 목록에서 봇을 여러 개 눌러 고른 다음 한 번에 넣으면 돼요. 키워드로 자동으로 찾을 수도 있어요.</div>'}
    <div class="se-list">${rows || '<div class="kts-empty">맞는 봇이 없어요.</div>'}
        ${bots.length > shown.length ? `<button class="kts-b se-more" data-act="se-more">더 보기 (${bots.length - shown.length}명 남음)</button>` : ''}</div>
    ${foot}`;
}

export function seriesHtml() {
    if (!state.hub && !state.hubLoading) loadHub();
    return ser().view === 'find' ? findHtml() : listHtml();
}

// ---------------------------------------------------------------- events

async function askName(title, value = '') {
    const name = await ctx().Popup.show.input(title, '시리즈 이름을 정해주세요. 예: 해포 시리즈, 현대 로맨스, 시뮬봇', value);
    return typeof name === 'string' ? name.trim().slice(0, 40) : '';
}

async function createSeries() {
    const name = await askName('🗂️ 새 시리즈');
    if (!name) return null;
    const list = allSeries();
    if (list.some((x) => x.name === name)) { toastr.warning('같은 이름의 시리즈가 이미 있어요.', TOAST); return null; }
    const sr = { id: newId(), name, color: LINE_COLORS[list.length % LINE_COLORS.length], members: [], keywords: '', exclude: '', minHits: 2, syncTag: false };
    list.push(sr);
    save();
    return sr;
}

export async function seriesClick(act, el) {
    const st = ser();
    switch (act) {
        case 'se-filter': st.filter = el.dataset.v; st.page = 1; app.render(); return true;
        case 'se-new': { const sr = await createSeries(); if (sr) { st.filter = sr.id; app.render(); } return true; }
        case 'se-pick': {
            const a = el.dataset.avatar;
            if (st.sel.has(a)) st.sel.delete(a); else st.sel.add(a);
            app.render();
            return true;
        }
        case 'se-visible': {
            const ids = [...document.querySelectorAll('#kts-root .se-list .se-row[data-act="se-pick"]')].map((x) => x.dataset.avatar);
            const allOn = ids.length && ids.every((a) => st.sel.has(a));
            for (const a of ids) { if (allOn) st.sel.delete(a); else st.sel.add(a); }
            app.render();
            return true;
        }
        case 'se-clear': st.sel.clear(); app.render(); return true;
        case 'se-more': st.page++; app.render(); return true;
        case 'se-remove': {
            const sr = seriesById(st.filter);
            if (!sr) return true;
            const n = await removeFrom(sr, [...st.sel]);
            st.sel.clear();
            toastr.success(`「${sr.name}」에서 ${n}명을 뺐어요.`, TOAST);
            app.render();
            return true;
        }
        case 'se-rename': {
            const sr = seriesById(st.filter);
            if (!sr) return true;
            const name = await askName('시리즈 이름 바꾸기', sr.name);
            if (!name || name === sr.name) return true;
            sr.name = name;
            save();
            if (sr.syncTag) {
                const api = await tagsApi();
                const tag = api?.tags?.find((t) => t.id === sr.tagId);
                if (tag) { tag.name = name; ctx().saveSettingsDebounced?.(); try { api.printTagFilters?.(); } catch { /* */ } }
            }
            app.render();
            return true;
        }
        case 'se-delete': {
            const sr = seriesById(st.filter);
            if (!sr) return true;
            const { Popup, POPUP_RESULT } = ctx();
            const ok = await Popup.show.confirm('🗂️ 시리즈 없애기', `「${esc(sr.name)}」 시리즈를 없앨까요?<br><small>봇은 지워지지 않아요.${sr.syncTag ? ' 실리 태그는 남겨둬요. 필요 없으면 실리 태그 관리에서 지워주세요.' : ''}</small>`);
            if (ok !== POPUP_RESULT.AFFIRMATIVE) return true;
            const s = getSettings();
            s.series = allSeries().filter((x) => x.id !== sr.id);
            save();
            st.filter = 'all';
            app.render();
            return true;
        }
        case 'se-find': {
            const sr = seriesById(st.filter);
            if (!sr) return true;
            st.find = { seriesId: sr.id, keywords: sr.keywords || '', exclude: sr.exclude || '', minHits: sr.minHits || 2, results: null, pick: new Set() };
            st.view = 'find';
            app.render();
            return true;
        }
        case 'se-find-close': st.view = 'list'; st.find = null; app.render(); return true;
        case 'se-find-run': if (!st.find?.busy) await runFind(); return true;
        case 'se-find-pick': {
            const a = el.dataset.avatar;
            if (st.find.pick.has(a)) st.find.pick.delete(a); else st.find.pick.add(a);
            app.render();
            return true;
        }
        case 'se-find-all': {
            const f = st.find;
            f.pick = f.pick.size === f.results.length ? new Set() : new Set(f.results.map((r) => r.avatar));
            app.render();
            return true;
        }
        case 'se-find-add': {
            const sr = seriesById(st.find.seriesId);
            const n = await addTo(sr, [...st.find.pick]);
            toastr.success(`「${sr.name}」에 ${n}명을 넣었어요.`, TOAST);
            st.view = 'list';
            st.find = null;
            app.render();
            return true;
        }
    }
    return false;
}

export function seriesInput(ev) {
    const st = ser();
    const id = ev.target.id;
    if (id === 'kts-se-search') { st.query = ev.target.value; st.page = 1; app.render(); return true; }
    // finder fields: keep the value without redrawing (typing stays smooth)
    if (id === 'kts-se-kw' && st.find) { st.find.keywords = ev.target.value; return true; }
    if (id === 'kts-se-ex' && st.find) { st.find.exclude = ev.target.value; return true; }
    if (id === 'kts-se-min' && st.find) { st.find.minHits = Math.max(1, parseInt(ev.target.value) || 1); return true; }
    return false;
}

export async function seriesChange(ev) {
    const st = ser();
    const id = ev.target.id;
    if (id === 'kts-se-target') {
        const v = ev.target.value;
        if (!v) return true;
        const sr = v === '__new' ? await createSeries() : seriesById(v);
        if (!sr) { ev.target.value = ''; return true; }
        const n = await addTo(sr, [...st.sel]);
        st.sel.clear();
        toastr.success(`「${sr.name}」에 ${n}명을 넣었어요.`, TOAST);
        app.render();
        return true;
    }
    if (id === 'kts-se-tag') {
        const sr = seriesById(st.filter);
        if (!sr) return true;
        sr.syncTag = ev.target.checked;
        save();
        if (sr.syncTag && await syncTag(sr)) toastr.success(`실리 태그 「${sr.name}」를 ${sr.members.length}명에게 붙였어요.`, TOAST);
        else if (!sr.syncTag) toastr.info('앞으로는 실리 태그를 같이 바꾸지 않아요. 이미 붙은 태그는 그대로 있어요.', TOAST);
        app.render();
        return true;
    }
    return false;
}
