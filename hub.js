// 깡통 노선도 - "최근 탑승" (all characters) and "승차 기록" (stats) tabs

import {
    STATUS, TOAST, LOG, state, app, getSettings, save, entry, esc, cut, fmtAgo, fmtBytes, parseDate, parseSize,
    fallbackTitle, charByAvatar, avatarUrl, fetchRecentChats, openChatOf, pad, ctx, openChar, storeFor,
    deleteChatFile, statusForChat,
} from './core.js';
import { cleanCfg } from './extras.js';

const PAGE = 40;
const DAY = 86400e3;
// 💤 follows the same day count as the automatic 운휴 status (설정 → 운행 상태 자동 분류)
const dormantDays = () => Math.max(1, Number(getSettings().restDays) || 60);

const CACHE_KEY = 'kkangtong_subway_hub_v2';
const STALE_MS = 30 * 60e3; // re-count in the background when the saved tally is older than this
const lf = () => SillyTavern.libs?.localforage || globalThis.localforage || null;

async function readCache() {
    try { return await lf()?.getItem(CACHE_KEY); } catch { return null; }
}

async function writeCache(hub) {
    try { await lf()?.setItem(CACHE_KEY, { at: hub.at, chats: hub.chats }); } catch { /* storage full or unavailable */ }
}

/**
 * Tallying every chat file is slow, so the result is kept:
 * - in memory for this page session, and
 * - in browser storage, so after a reload the tabs open instantly and re-count quietly if it is old.
 */
export async function loadHub(force = false) {
    if (state.hubLoading || state.hubReading || (state.hub && !force)) return;
    if (!state.hub && !force) {
        state.hubReading = true;
        const cached = await readCache();
        state.hubReading = false;
        if (cached?.chats?.length) {
            const chats = cached.chats.filter((c) => charByAvatar(c.avatar));
            state.hub = { at: cached.at, chats, bots: groupBots(chats) };
            state.hubPage = 1;
            app.render();
            if (Date.now() - cached.at < STALE_MS) return;
        }
    }
    state.hubLoading = true;
    app.render();
    try {
        const raw = await fetchRecentChats();
        const chats = [];
        for (const x of raw) {
            if (!x?.avatar || x.group) continue;
            if (!charByAvatar(x.avatar)) continue;
            const id = String(x.file_id ?? String(x.file_name).replace(/\.jsonl$/, ''));
            const parent = x.chat_metadata?.main_chat ? String(x.chat_metadata.main_chat).replace(/\.jsonl$/, '') : null;
            chats.push({ avatar: x.avatar, id, parent, count: Number(x.chat_items) || 0, size: parseSize(x.file_size), lastDate: parseDate(x.last_mes, id) });
        }
        state.hub = { at: Date.now(), chats, bots: groupBots(chats) };
        state.hubPage = state.hubPage || 1;
        writeCache(state.hub);
    } catch (err) {
        console.error(LOG, 'hub load failed', err);
        toastr.error('전체 노선을 불러오지 못했어요.', TOAST);
    }
    state.hubLoading = false;
    app.render();
}

function groupBots(chats) {
    const bots = new Map();
    for (const c of chats) {
        let b = bots.get(c.avatar);
        if (!b) {
            b = { avatar: c.avatar, name: charByAvatar(c.avatar)?.char?.name || c.avatar, chats: 0, messages: 0, size: 0, last: 0, lastChat: null };
            bots.set(c.avatar, b);
        }
        b.chats++;
        b.messages += c.count;
        b.size += c.size;
        if (c.lastDate >= b.last) { b.last = c.lastDate; b.lastChat = c.id; }
    }
    return [...bots.values()].sort((a, b) => b.last - a.last);
}

function loadingHtml() {
    return '<div class="kts-empty">전체 노선을 집계하는 중… 🚇<br><small>챗이 많으면 조금 걸려요</small></div>';
}

const pinnedBots = () => {
    const s = getSettings();
    if (!Array.isArray(s.pinnedBots)) s.pinnedBots = [];
    return s.pinnedBots;
};

// ---------------------------------------------------------------- cleanup candidates (all bots)

function cleanupCandidates() {
    const chats = state.hub?.chats || [];
    const hasKids = new Set(chats.filter((c) => c.parent).map((c) => `${c.avatar}|${c.parent}`));
    const open = openChar();
    const openId = open ? ctx().getCurrentChatId?.() : null;
    const now = Date.now();
    const cfg = cleanCfg();
    const out = [];
    for (const c of chats) {
        if (open && c.avatar === open.avatar && c.id === openId) continue;
        const e = entry(c.id, c.avatar);
        if (e.pinned || e.status === 'run' || e.status === 'end') continue;
        const kids = hasKids.has(`${c.avatar}|${c.id}`);
        let reason = null;
        if (c.count <= 1) reason = '그리팅만';
        else if (e.status === 'test') reason = '시험운행';
        else if (c.count <= cfg.shortMax && !kids) reason = `메시지 ${c.count}개`;
        else if (now - c.lastDate > cfg.staleDays * DAY && c.count < cfg.staleMax && !kids) reason = `${cfg.staleDays}일 넘게 방치`;
        if (reason) out.push({ ...c, reason, key: `${c.avatar}|${c.id}` });
    }
    return out;
}

function stTags() {
    const c = ctx();
    const tags = Array.isArray(c.tags) ? c.tags : [];
    const map = c.tagMap || {};
    return { tags, map };
}

function statusCounts(avatar) {
    const counts = {};
    for (const c of state.hub.chats) {
        if (c.avatar !== avatar) continue;
        const st = statusForChat(entry(c.id, avatar), c).key;
        if (st) counts[st] = (counts[st] || 0) + 1;
    }
    return Object.entries(STATUS).filter(([k]) => counts[k]).map(([k, v]) => `<span title="${v.label}">${v.icon}${counts[k]}</span>`).join('');
}

// ---------------------------------------------------------------- 🧹 정리 센터

function cleanHtml() {
    const list = cleanupCandidates();
    const off = state.cleanOff || (state.cleanOff = new Set());
    const byBot = new Map();
    for (const c of list) {
        if (!byBot.has(c.avatar)) byBot.set(c.avatar, []);
        byBot.get(c.avatar).push(c);
    }
    const picked = list.filter((c) => !off.has(c.key)).length;
    const groups = [...byBot.entries()].sort((a, b) => b[1].length - a[1].length).map(([avatar, items]) => {
        const allOn = items.every((c) => !off.has(c.key));
        return `<section class="kts-cl-grp">
            <header><button class="kts-ck ${allOn ? 'on' : ''}" data-act="clean-bot" data-avatar="${esc(avatar)}">${allOn ? '✓' : ''}</button>
                <img src="${esc(avatarUrl(avatar))}" alt="" loading="lazy"><b>${esc(charByAvatar(avatar)?.char?.name || avatar)}</b><small>${items.length}개</small></header>
            ${items.map((c) => `<div class="kts-cl-row ${off.has(c.key) ? 'off' : ''}" data-act="clean-one" data-key="${esc(c.key)}">
                <span class="kts-ck ${off.has(c.key) ? '' : 'on'}">${off.has(c.key) ? '' : '✓'}</span>
                <span class="t">${esc(cut(entry(c.id, c.avatar).title || fallbackTitle(c.id), 34))}</span>
                <span class="kts-tag reason">🧹 ${esc(c.reason)}</span>
                <span class="m">${c.count} · ${fmtAgo(c.lastDate)}</span></div>`).join('')}
        </section>`;
    }).join('');
    return `<div class="kts-toolbar">
        <button class="kts-pill" data-act="clean-close">← 최근 탑승</button>
        <span class="kts-cur">🧹 전체 정리 센터 <small>봇 ${byBot.size}개 · 후보 ${list.length}개</small></span>
        <span style="flex:1"></span>
        <button class="kts-pill" data-act="clean-all">${picked === list.length ? '전부 해제' : '전부 선택'}</button>
    </div>
    <div class="kts-clean-note">그리팅만 있는 챗 · 🧪시험운행 · 메시지 ${cleanCfg().shortMax}개 이하 · ${cleanCfg().staleDays}일 넘게 안 탄 ${cleanCfg().staleMax}개 미만 챗을 모았어요. 기준은 ⚙️에서 바꿀 수 있어요. ⭐ · 🟢(직접 붙인 것) · 🏁 · 분기가 있는 챗 · 지금 열린 챗은 빠져요. 체크를 풀면 남겨요.</div>
    <div class="kts-clean">${groups || '<div class="kts-empty small">정리할 챗이 없어요. 깔끔하네요! ✨</div>'}</div>
    ${list.length ? `<div class="kts-foot"><span>${picked}개 선택됨</span><button class="kts-b d" data-act="clean-delete" ${picked ? '' : 'disabled'}>🗑️ ${picked}개 폐역</button></div>` : ''}`;
}

async function runCleanDelete() {
    const off = state.cleanOff || new Set();
    const targets = cleanupCandidates().filter((c) => !off.has(c.key));
    if (!targets.length) return;
    const c = ctx();
    const bots = new Set(targets.map((t) => t.avatar)).size;
    const ok = await c.Popup.show.confirm(`🗑️ ${targets.length}개 폐역`, `<div class="kts-pop-list"><p>봇 ${bots}개에 걸친 챗 파일 <b>${targets.length}개</b>를 <b>완전히 삭제</b>해요. 되돌릴 수 없어요.</p></div>`);
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;
    state.cleaning = true;
    app.render();
    let done = 0;
    const gone = new Set();
    for (const t of targets) {
        try {
            await deleteChatFile(t.avatar, t.id);
            delete storeFor(t.avatar)[t.id];
            gone.add(t.key);
            done++;
        } catch (err) {
            console.error(LOG, 'delete failed', t, err);
        }
    }
    save();
    state.hub.chats = state.hub.chats.filter((x) => !gone.has(`${x.avatar}|${x.id}`));
    state.hub.bots = groupBots(state.hub.chats);
    writeCache(state.hub);
    state.cleaning = false;
    off.clear();
    toastr.success(`${done}개 폐역 완료${done < targets.length ? ` · 실패 ${targets.length - done}개` : ''}`, TOAST);
    if (state.avatar && targets.some((t) => t.avatar === state.avatar)) state.mapStale = true;
    app.render();
}

// ---------------------------------------------------------------- 최근 탑승

const BOT_SORTS = { recent: '최근 탑승순', messages: '메시지순', chats: '역 개수순', name: '이름순' };

export function recentHtml() {
    if (!state.hub) { loadHub(); return loadingHtml(); }
    if (state.hubView === 'clean') return cleanHtml();
    const q = state.hubQuery.trim().toLowerCase();
    const { tags, map: tagMap } = stTags();
    const pins = pinnedBots();
    const sort = state.hubSort || 'recent';
    const now = Date.now();
    let bots = state.hub.bots.filter((b) => !q || b.name.toLowerCase().includes(q));
    const dormantCount = state.hub.bots.filter((b) => now - b.last > dormantDays() * DAY).length;
    if (state.hubDormant) bots = bots.filter((b) => now - b.last > dormantDays() * DAY);
    if (state.hubTag) bots = bots.filter((b) => (tagMap[b.avatar] || []).includes(state.hubTag));
    const cand = cleanupCandidates();
    const candBy = new Map();
    for (const c of cand) candBy.set(c.avatar, (candBy.get(c.avatar) || 0) + 1);
    const usedTags = new Set(state.hub.bots.flatMap((b) => tagMap[b.avatar] || []));
    const tagOpts = tags.filter((t) => usedTags.has(t.id)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'))
        .map((t) => `<option value="${esc(t.id)}" ${state.hubTag === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    const open = state.hubOpen || (state.hubOpen = new Set());
    const cmp = {
        recent: (a, b) => b.last - a.last,
        messages: (a, b) => b.messages - a.messages,
        chats: (a, b) => b.chats - a.chats,
        name: (a, b) => a.name.localeCompare(b.name, 'ko'),
    }[sort];
    bots = [...bots].sort((a, b) => (pins.includes(b.avatar) - pins.includes(a.avatar)) || cmp(a, b));
    const shown = bots.slice(0, PAGE * (state.hubPage || 1));
    const cards = shown.map((b) => {
        const e = entry(b.lastChat, b.avatar);
        const pinned = pins.includes(b.avatar);
        const dormant = now - b.last > dormantDays() * DAY;
        const expanded = open.has(b.avatar);
        const nClean = candBy.get(b.avatar) || 0;
        const recent = expanded ? state.hub.chats.filter((c) => c.avatar === b.avatar).sort((x, y) => y.lastDate - x.lastDate).slice(0, 5) : [];
        return `<div class="kts-bot ${pinned ? 'pinned' : ''} ${expanded ? 'open' : ''}">
            <div class="top" data-act="hub-map" data-avatar="${esc(b.avatar)}">
                <img class="av" src="${esc(avatarUrl(b.avatar))}" alt="" loading="lazy">
                <div class="info">
                    <div class="nm">${esc(b.name)}${dormant ? ' <span class="kts-tag dorm">💤 휴면</span>' : ''}</div>
                    <div class="st">🚉 ${esc(cut(e.title || fallbackTitle(b.lastChat), 26))}</div>
                    <div class="mt">${fmtAgo(b.last)} · 역 ${b.chats}개 · 메시지 ${b.messages.toLocaleString()}개</div>
                    <div class="sc">${statusCounts(b.avatar)}${nClean ? `<span class="cl" title="정리할 만한 챗">🧹${nClean}</span>` : ''}</div>
                </div>
                <button class="kts-star ${pinned ? 'on' : ''}" data-act="hub-pin" data-avatar="${esc(b.avatar)}" title="${pinned ? '즐겨찾기 해제' : '즐겨찾는 봇으로 고정'}">${pinned ? '★' : '☆'}</button>
                <button class="kts-b p go" data-act="hub-ride" data-avatar="${esc(b.avatar)}" data-id="${esc(b.lastChat)}" title="마지막 역으로 바로 탑승">🚇</button>
            </div>
            ${expanded ? `<div class="kts-bot-list">${recent.map((c) => {
                const ce = entry(c.id, b.avatar);
                const st = statusForChat(ce, c).key;
                return `<div class="r" data-act="hub-goto" data-avatar="${esc(b.avatar)}" data-id="${esc(c.id)}">
                    <div class="t">${st ? STATUS[st].icon : ''} ${esc(cut(ce.title || fallbackTitle(c.id), 30))}<small>${esc(cut(ce.summary || '', 60))}</small></div>
                    <span class="m">${c.count} · ${fmtAgo(c.lastDate)}</span>
                    <button class="kts-mini ride" data-act="hub-ride" data-avatar="${esc(b.avatar)}" data-id="${esc(c.id)}" title="이 역으로 탑승">🚇</button></div>`;
            }).join('')}</div>` : ''}
            <button class="kts-bot-more" data-act="hub-expand" data-avatar="${esc(b.avatar)}">${expanded ? '접기 ▴' : `최근 역 보기 ▾`}</button>
        </div>`;
    }).join('');
    const more = bots.length > shown.length ? `<button class="kts-b more" data-act="hub-more">더 보기 (${bots.length - shown.length}개 남음)</button>` : '';
    const sortOpts = Object.entries(BOT_SORTS).map(([k, v]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${v}</option>`).join('');
    const empty = state.hubDormant ? '한 달 넘게 안 탄 봇이 없어요. 부지런하시네요!' : '찾는 봇이 없어요.';
    return `<div class="kts-toolbar">
        <span class="kts-cur">최근 탑승 <small>봇 ${state.hub.bots.length}개 · ${fmtAgo(state.hub.at)} 집계</small></span>
        <input class="kts-search" id="kts-hub-search" type="search" placeholder="🔍 봇 이름으로 찾기" value="${esc(state.hubQuery)}">
        <select class="kts-pill" id="kts-hub-sort">${sortOpts}</select>
        ${tagOpts ? `<select class="kts-pill" id="kts-hub-tag" title="실리에서 붙인 캐릭터 태그로 거르기"><option value="">🏷️ 모든 태그</option>${tagOpts}</select>` : ''}
        <button class="kts-pill ${state.hubDormant ? 'on' : ''}" data-act="hub-dormant" title="${dormantDays()}일 넘게 안 탄 봇만 보기">💤 휴면 노선 ${dormantCount}</button>
        <button class="kts-pill cl" data-act="clean-open" title="모든 봇의 정리할 만한 챗을 한 화면에서">🧹 정리 센터 ${cand.length}</button>
        <button class="kts-pill" data-act="hub-reload" ${state.hubLoading ? 'disabled' : ''}>${state.hubLoading ? '집계 중…' : '↻ 새로 집계'}</button>
    </div>
    <div class="kts-hub">${cards || `<div class="kts-empty small">${empty}</div>`}${more}</div>`;
}

// ---------------------------------------------------------------- 승차 기록

const PERIODS = { week: ['이번 주', 7], month: ['이번 달', 30], year: ['올해', 365], all: ['전체', Infinity] };

function bar(label, value, max, extra, color, attrs = '') {
    const w = max ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return `<div class="kts-bar ${attrs ? 'link' : ''}" ${attrs}><span class="l">${label}</span><span class="b"><i style="width:${w}%;background:${color}"></i></span><span class="v">${extra}</span></div>`;
}

const HOUR_LABEL = (h) => (h < 6 ? `새벽 ${h || 12}시` : h < 12 ? `오전 ${h}시` : h < 18 ? `오후 ${h === 12 ? 12 : h - 12}시` : `밤 ${h - 12}시`);
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function grassHtml(chats) {
    const counts = new Map();
    for (const c of chats) {
        if (!c.lastDate) continue;
        const k = dayKey(new Date(c.lastDate));
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 7 * 52 - today.getDay());
    const vals = [...counts.values()].sort((a, b) => a - b);
    const q = (p) => vals[Math.floor((vals.length - 1) * p)] || 1;
    const level = (n) => (!n ? 0 : n <= q(0.25) ? 1 : n <= q(0.5) ? 2 : n <= q(0.8) ? 3 : 4);
    const cols = [];
    const months = [];
    let active = 0;
    for (let w = 0; w < 53; w++) {
        const cells = [];
        for (let d = 0; d < 7; d++) {
            const day = new Date(start);
            day.setDate(start.getDate() + w * 7 + d);
            if (day > today) { cells.push('<i class="x"></i>'); continue; }
            const n = counts.get(dayKey(day)) || 0;
            if (n) active++;
            if (day.getDate() === 1) {
                const left = (w / 53) * 100;
                // keep the last label inside the box instead of wrapping off the edge
                months.push(`<span class="${left > 92 ? 'end' : ''}" style="left:${left > 92 ? 100 : left}%">${day.getMonth() + 1}월</span>`);
            }
            cells.push(`<i class="g${level(n)}" title="${day.getMonth() + 1}월 ${day.getDate()}일 · ${n ? `${n}개 역` : '운행 없음'}"></i>`);
        }
        cols.push(`<div>${cells.join('')}</div>`);
    }
    return `<div class="kts-grass-wrap"><div class="kts-grass-months">${months.join('')}</div><div class="kts-grass">${cols.join('')}</div></div>
        <div class="kts-grass-lg"><span>최근 1년 중 <b>${active}일</b> 운행</span><span>적음 <i class="g1"></i><i class="g2"></i><i class="g3"></i><i class="g4"></i> 많음</span></div>`;
}

function dayIndex() {
    const d = new Date();
    return Math.floor((d.getTime() - d.getTimezoneOffset() * 60e3) / DAY);
}

function pickRecommendation() {
    const now = Date.now();
    let pool = state.hub.chats.filter((c) => c.count >= 50 && now - c.lastDate > 30 * DAY);
    if (!pool.length) pool = state.hub.chats.filter((c) => c.count >= 20 && now - c.lastDate > 14 * DAY);
    if (!pool.length) return null;
    pool.sort((a, b) => (a.avatar + a.id).localeCompare(b.avatar + b.id));
    const seed = (dayIndex() * 2654435761 + (state.pickOffset || 0) * 40503) >>> 0;
    return pool[seed % pool.length];
}

function recommendHtml() {
    const c = pickRecommendation();
    if (!c) return '';
    const e = entry(c.id, c.avatar);
    const name = charByAvatar(c.avatar)?.char?.name || c.avatar;
    const days = Math.floor((Date.now() - c.lastDate) / DAY);
    return `<div class="kts-pick">
        <img src="${esc(avatarUrl(c.avatar))}" alt="" loading="lazy">
        <div class="info">
            <small>🎲 오늘의 노선 추천 · ${days}일 만의 재탑승</small>
            <b>${esc(cut(e.title || fallbackTitle(c.id), 30))}</b>
            <span>${esc(name)} · 메시지 ${c.count.toLocaleString()}개</span>
            ${e.summary ? `<p>${esc(cut(e.summary, 110))}</p>` : ''}
        </div>
        <div class="btns">
            <button class="kts-b p" data-act="hub-ride" data-avatar="${esc(c.avatar)}" data-id="${esc(c.id)}">🚇 다시 탑승</button>
            <button class="kts-b" data-act="hub-goto" data-avatar="${esc(c.avatar)}" data-id="${esc(c.id)}">🗺️ 노선도</button>
            <button class="kts-b" data-act="pick-next">🎲 다른 노선</button>
        </div>
    </div>`;
}

function monthlyHtml() {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ y: d.getFullYear(), m: d.getMonth(), n: 0 });
    }
    for (const c of state.hub.chats) {
        if (!c.lastDate) continue;
        const d = new Date(c.lastDate);
        const hit = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
        if (hit) hit.n++;
    }
    const max = Math.max(...months.map((x) => x.n), 1);
    const top = months.reduce((a, b) => (b.n > a.n ? b : a), months[0]);
    return `<div class="kts-months">${months.map((x) => `<div title="${x.y}년 ${x.m + 1}월 · ${x.n}개"><em>${x.n || ''}</em><i style="height:${Math.round((x.n / max) * 100)}%" class="${x === top && x.n ? 'pk' : ''}"></i><span>${x.m + 1}월</span></div>`).join('')}</div>`;
}

export function statsHtml() {
    if (!state.hub) { loadHub(); return loadingHtml(); }
    const period = state.statsPeriod || 'all';
    const [periodLabel, days] = PERIODS[period];
    const now = Date.now();
    const chats = state.hub.chats.filter((c) => days === Infinity || now - c.lastDate <= days * DAY);
    const bots = groupBots(chats);
    const totalMsg = chats.reduce((n, c) => n + c.count, 0);
    const totalSize = chats.reduce((n, c) => n + c.size, 0);
    const nameOf = (avatar) => charByAvatar(avatar)?.char?.name || avatar;
    const titleOf = (c) => entry(c.id, c.avatar).title || fallbackTitle(c.id);

    const topBots = [...bots].sort((a, b) => b.messages - a.messages).slice(0, 6);
    const topRiders = [...bots].sort((a, b) => b.chats - a.chats).slice(0, 5);

    const hours = Array(24).fill(0);
    const weekdays = Array(7).fill(0);
    for (const c of chats) {
        if (!c.lastDate) continue;
        const d = new Date(c.lastDate);
        hours[d.getHours()]++;
        weekdays[d.getDay()]++;
    }
    const peak = hours.indexOf(Math.max(...hours));
    const hourMax = Math.max(...hours, 1);
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayMax = Math.max(...weekdays, 1);
    const longest = [...chats].sort((a, b) => b.count - a.count)[0];
    const newest = [...chats].sort((a, b) => b.lastDate - a.lastDate)[0];

    // 정리 현황: every station of every bot (not only the ones you tagged by hand), auto statuses included
    const everyChat = state.hub.chats;
    let titled = 0;
    let summarized = 0;
    let pinned = 0;
    const tags = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
    const handTags = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
    for (const c of everyChat) {
        const e = entry(c.id, c.avatar);
        if (e.title) titled++;
        if (e.summary) summarized++;
        if (e.pinned) pinned++;
        const st = statusForChat(e, c);
        if (st.key && tags[st.key] !== undefined) { tags[st.key]++; if (!st.auto) handTags[st.key]++; }
    }
    const total = everyChat.length || 1;
    const pct = (n) => Math.round((n / total) * 100);
    // the longest chat you haven't ridden for a while: a good one to come back to
    const sleeping = everyChat.filter((c) => c !== longest && c.count >= 20 && now - c.lastDate > 30 * DAY).sort((a, b) => b.count - a.count)[0];

    const go = (c) => `data-act="hub-goto" data-avatar="${esc(c.avatar)}" data-id="${esc(c.id)}"`;
    const ticker = [
        topBots[0] && `🏆 최다 탑승 노선 「${topBots[0].name}」`,
        hours[peak] && `${peak < 6 ? '🌙' : peak < 18 ? '☀️' : '🌆'} ${HOUR_LABEL(peak)} 탑승률 1위`,
        longest && `🛤️ 최장 노선 「${cut(titleOf(longest), 18)}」 ${longest.count.toLocaleString()}개`,
        newest && `🚉 마지막 정차 「${cut(titleOf(newest), 18)}」 ${fmtAgo(newest.lastDate)}`,
    ].filter(Boolean).map(esc).join('<span class="sep">◆</span>');
    const periodBtns = Object.entries(PERIODS).map(([k, [label]]) => `<button class="${period === k ? 'on' : ''}" data-act="stats-period" data-v="${k}">${label}</button>`).join('');

    return `<div class="kts-toolbar">
        <span class="kts-cur">승차 기록 <small>${fmtAgo(state.hub.at)} 집계</small></span>
        <span class="kts-seg">${periodBtns}</span>
        <button class="kts-pill" data-act="hub-reload" ${state.hubLoading ? 'disabled' : ''}>${state.hubLoading ? '집계 중…' : '↻ 새로 집계'}</button>
    </div>
    <div class="kts-stats-page">
        <div class="kts-led">
            <div class="kts-led-head"><span class="lamp"></span>운행 정보 <b>${periodLabel}</b><span class="clock">${pad(new Date().getHours())}:${pad(new Date().getMinutes())}</span></div>
            <div class="kts-led-cells">
                <div><span class="k">탑승한 봇</span><span class="n">${bots.length.toLocaleString()}</span></div>
                <div><span class="k">운행한 역</span><span class="n">${chats.length.toLocaleString()}</span></div>
                <div><span class="k">누적 메시지</span><span class="n">${totalMsg.toLocaleString()}</span></div>
                <div><span class="k">총 용량</span><span class="n">${fmtBytes(totalSize)}</span></div>
            </div>
            ${ticker ? `<div class="kts-led-ticker"><div class="run">${ticker}<span class="sep">◆</span>${ticker}</div></div>` : ''}
        </div>
        ${recommendHtml()}
        <div class="kts-card wide">
            <h4>🌱 탑승 잔디 <small>최근 1년 · 그날 마지막으로 탄 역 수</small></h4>
            ${grassHtml(state.hub.chats)}
        </div>
        ${chats.length ? `<div class="kts-cards">
            <div class="kts-card">
                <h4>🏆 가장 많이 탄 노선 <small>메시지 수 · 누르면 노선도로</small></h4>
                ${topBots.map((b) => bar(esc(cut(b.name, 14)), b.messages, topBots[0]?.messages, b.messages.toLocaleString(), 'var(--kts-accent)', `data-act="hub-map" data-avatar="${esc(b.avatar)}"`)).join('')}
            </div>
            <div class="kts-card">
                <h4>🔥 자주 타는 노선 <small>${periodLabel} · 탑승한 역 수</small></h4>
                ${topRiders.map((b) => bar(esc(cut(b.name, 14)), b.chats, topRiders[0]?.chats, `${b.chats}개`, '#7b6cf6', `data-act="hub-map" data-avatar="${esc(b.avatar)}"`)).join('')}
            </div>
            <div class="kts-card wide">
                <h4>📆 월별 탑승 <small>최근 12개월 · 그달 마지막으로 탄 역 수</small></h4>
                ${monthlyHtml()}
            </div>
            <div class="kts-card wide">
                <h4>🏋️ 가장 무거운 역 <small>${periodLabel} · 파일 용량 · 누르면 그 역으로</small></h4>
                ${[...chats].sort((a, b) => b.size - a.size).slice(0, 8).map((c) => bar(`${esc(cut(titleOf(c), 18))} <small>${esc(cut(nameOf(c.avatar), 10))}</small>`, c.size, chats.reduce((m, x) => Math.max(m, x.size), 0), fmtBytes(c.size), '#e9a23b', go(c))).join('')}
            </div>
            <div class="kts-card wide">
                <h4>🕐 시간대별 탑승</h4>
                <div class="kts-hours">${hours.map((n, h) => `<div title="${h}시 · ${n}개"><i style="height:${Math.round((n / hourMax) * 100)}%" class="${h === peak ? 'pk' : ''}"></i><span>${h % 3 === 0 ? h : ''}</span></div>`).join('')}</div>
            </div>
            <div class="kts-card">
                <h4>📅 요일별 탑승</h4>
                ${weekdays.map((n, i) => bar(dayNames[i], n, dayMax, `${n}`, '#3fa7d6')).join('')}
            </div>
            <div class="kts-card">
                <h4>🛤️ 기록 <small>누르면 그 역으로</small></h4>
                <div class="kts-facts">
                    ${longest ? `<div class="link" ${go(longest)}><small>최장 노선</small><b>${esc(cut(titleOf(longest), 22))}</b><span>${esc(nameOf(longest.avatar))} · 메시지 ${longest.count.toLocaleString()}개</span></div>` : ''}
                    ${newest ? `<div class="link" ${go(newest)}><small>마지막 정차역</small><b>${esc(cut(titleOf(newest), 22))}</b><span>${esc(nameOf(newest.avatar))} · ${fmtAgo(newest.lastDate)}</span></div>` : ''}
                    ${sleeping ? `<div class="link" ${go(sleeping)}><small>오래 잠든 노선</small><b>${esc(cut(titleOf(sleeping), 22))}</b><span>${esc(nameOf(sleeping.avatar))} · 메시지 ${sleeping.count.toLocaleString()}개 · ${fmtAgo(sleeping.lastDate)} 탑승</span></div>` : ''}
                    <div class="kts-tidy"><small>노선도 정리 현황 · 전체 역 ${everyChat.length.toLocaleString()}개</small>
                        <div class="row"><span>🏷️ 이름</span><i><em style="width:${pct(titled)}%"></em></i><b>${titled}</b></div>
                        <div class="row"><span>🤖 요약</span><i><em style="width:${pct(summarized)}%"></em></i><b>${summarized}</b></div>
                        <div class="sts">${Object.entries(STATUS).map(([k, v]) => `<span title="${v.label}${handTags[k] ? ` · 직접 붙인 것 ${handTags[k]}개` : ''}">${v.icon} ${v.label} <b>${tags[k]}</b></span>`).join('')}<span>⭐ 즐겨찾기 <b>${pinned}</b></span></div>
                    </div>
                </div>
            </div>
        </div>` : `<div class="kts-empty small">${periodLabel}에는 운행 기록이 없어요.</div>`}
    </div>`;
}

// ---------------------------------------------------------------- actions

async function openMapOf(avatar, id = null) {
    state.tab = 'map';
    state.query = '';
    state.filter = 'all';
    state.selectedId = null;
    await app.refresh({ avatar, keepSelection: false });
    if (id && state.byId.has(id)) {
        state.selectedId = id;
        state.mobileDetail = true;
        app.render();
    }
}

export async function hubClick(act, el) {
    switch (act) {
        case 'hub-reload': await loadHub(true); return true;
        case 'hub-more': state.hubPage = (state.hubPage || 1) + 1; app.render(); return true;
        case 'hub-dormant': state.hubDormant = !state.hubDormant; state.hubPage = 1; app.render(); return true;
        case 'hub-pin': {
            const pins = pinnedBots();
            const i = pins.indexOf(el.dataset.avatar);
            if (i >= 0) pins.splice(i, 1); else pins.push(el.dataset.avatar);
            save();
            app.render();
            return true;
        }
        case 'stats-period': state.statsPeriod = el.dataset.v; app.render(); return true;
        case 'pick-next': state.pickOffset = (state.pickOffset || 0) + 1; app.render(); return true;
        case 'hub-expand': {
            const set = state.hubOpen || (state.hubOpen = new Set());
            if (set.has(el.dataset.avatar)) set.delete(el.dataset.avatar); else set.add(el.dataset.avatar);
            app.render();
            return true;
        }
        case 'clean-open': state.hubView = 'clean'; app.render(); return true;
        case 'clean-close': state.hubView = 'list'; app.render(); return true;
        case 'clean-one': {
            const off = state.cleanOff || (state.cleanOff = new Set());
            const k = el.dataset.key;
            if (off.has(k)) off.delete(k); else off.add(k);
            app.render();
            return true;
        }
        case 'clean-bot': {
            const off = state.cleanOff || (state.cleanOff = new Set());
            const items = cleanupCandidates().filter((c) => c.avatar === el.dataset.avatar);
            const allOn = items.every((c) => !off.has(c.key));
            for (const c of items) { if (allOn) off.add(c.key); else off.delete(c.key); }
            app.render();
            return true;
        }
        case 'clean-all': {
            const off = state.cleanOff || (state.cleanOff = new Set());
            const list = cleanupCandidates();
            if (list.every((c) => !off.has(c.key))) list.forEach((c) => off.add(c.key)); else off.clear();
            app.render();
            return true;
        }
        case 'clean-delete': if (!state.cleaning) await runCleanDelete(); return true;
        case 'hub-map': await openMapOf(el.dataset.avatar); return true;
        case 'hub-goto': await openMapOf(el.dataset.avatar, el.dataset.id); return true;
        case 'hub-ride': {
            const { avatar, id } = el.dataset;
            app.closePopup();
            try { await openChatOf(avatar, id); } catch (err) { console.error(LOG, err); toastr.error('챗을 열지 못했어요.', TOAST); }
            return true;
        }
    }
    return false;
}

export function hubInput(ev) {
    if (ev.target.id === 'kts-hub-search') {
        state.hubQuery = ev.target.value;
        state.hubPage = 1;
        app.render();
        return true;
    }
    return false;
}

export function hubChange(ev) {
    if (ev.target.id === 'kts-hub-tag') {
        state.hubTag = ev.target.value || null;
        state.hubPage = 1;
        app.render();
        return true;
    }
    if (ev.target.id === 'kts-hub-sort') {
        state.hubSort = ev.target.value;
        state.hubPage = 1;
        app.render();
        return true;
    }
    return false;
}
