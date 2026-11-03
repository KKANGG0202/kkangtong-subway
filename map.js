// 깡통 노선도 - map tab (tree list + station detail)

import {
    STATUS, LINE_COLORS, TOAST, state, app, ctx, entry, setEntry, storeFor, esc, cut, fmtShort, fmtLong, fmtYmd, branchNo,
    fallbackTitle, title, hasTitle, currentChatId, isOpenCharView, openChar, isRoot, parentOf, buildTree, save,
    deleteChatFile, summarize, openChatOf, LOG, loadChat, shownText, linesFor, lineById, addLine, removeLine,
    getSettings, bulkSummarize, statusOf, statusIcon, CREATED_SORTS,
} from './core.js';
import { divergenceHtml, ensureDivergence, compareHtml, recommendCandidates } from './extras.js';

const ROW_H = 44;
const LANE_W = 24;
const LANE_X0 = 16;

// ---------------------------------------------------------------- filtering & flattening

function matches(id) {
    const e = entry(id);
    if (state.filter === 'pin' && !e.pinned) return false;
    if (STATUS[state.filter] && statusOf(id).key !== state.filter) return false;
    if (state.lineFilter === 'none' && lineById(e.line)) return false;
    if (state.lineFilter && state.lineFilter !== 'none' && e.line !== state.lineFilter) return false;
    const q = state.query.trim().toLowerCase();
    if (q) {
        const hay = `${e.title || ''} ${e.summary || ''} ${id} ${fallbackTitle(id)}`.toLowerCase();
        if (!hay.includes(q)) return false;
    }
    return true;
}

export function isFiltering() {
    return state.filter !== 'all' || state.query.trim() !== '' || !!state.lineFilter;
}

export function flatten({ ignoreView = false } = {}) {
    const filtering = !ignoreView && isFiltering();
    let visible = null;
    let hits = null;
    if (filtering) {
        hits = new Set(state.list.filter((c) => matches(c.id)).map((c) => c.id));
        visible = new Set(hits);
        for (const id of hits) {
            let node = state.byId.get(id);
            let guard = 0;
            while (node && !isRoot(node.id) && guard++ < 64) {
                visible.add(node.parent);
                node = state.byId.get(node.parent);
            }
        }
    }
    const rows = [];
    let maxDepth = 0;
    const kidsOf = (id) => {
        const kids = state.children.get(id) || [];
        if (!ignoreView && !filtering && state.collapsed.has(id)) return [];
        return visible ? kids.filter((k) => visible.has(k)) : kids;
    };
    const walk = (ids, depth, cont, ancestors, chain = false) => {
        const vis = visible ? ids.filter((x) => visible.has(x)) : ids;
        vis.forEach((id, i) => {
            const kids = kidsOf(id);
            const last = i === vis.length - 1;
            rows.push({ id, depth, first: i === 0 && !chain, chain: i === 0 && chain, last, hasKids: kids.length > 0, cont: [...cont], ancestors, dim: hits ? !hits.has(id) : false });
            maxDepth = Math.max(maxDepth, depth);
            if (!kids.length) return;
            // branch-of-a-branch chains would otherwise walk off the right edge (one lane per level):
            // when the last station on a branch has exactly one branch, draw it straight down the same lane
            if (depth > 0 && last && kids.length === 1) walk(kids, depth, cont, [...ancestors.slice(0, depth - 1), id], true);
            else walk(kids, depth + 1, [...cont, !last], [...ancestors, id]);
        });
    };
    walk(state.roots, 0, [], []);
    return { rows, maxDepth };
}

export function visibleIds() {
    if (viewMode() !== 'tree' && viewMode() !== 'rail') return groupedOrder().flatMap((g) => (state.groupCollapsed.has(g.key) ? [] : g.ids));
    return flatten().rows.filter((r) => !r.dim).map((r) => r.id);
}

const viewMode = () => getSettings().viewMode || 'tree';

// ---------------------------------------------------------------- grouped views (상태별 / 노선별)

function sortIds(ids) {
    const by = {
        recent: (a, b) => state.byId.get(b).lastDate - state.byId.get(a).lastDate,
        old: (a, b) => state.byId.get(a).lastDate - state.byId.get(b).lastDate,
        ...CREATED_SORTS,
        size: (a, b) => state.byId.get(b).size - state.byId.get(a).size,
        count: (a, b) => state.byId.get(b).count - state.byId.get(a).count,
    }[state.sort] || (() => 0);
    return ids.sort((a, b) => ((entry(b).pinned ? 1 : 0) - (entry(a).pinned ? 1 : 0)) || by(a, b));
}

function groupedOrder() {
    const ids = state.list.map((c) => c.id).filter(matches);
    const groups = [];
    if (viewMode() === 'status') {
        for (const [k, v] of Object.entries(STATUS)) {
            groups.push({ key: `status:${k}`, icon: v.icon, name: v.label, color: null, ids: sortIds(ids.filter((x) => statusOf(x).key === k)) });
        }
        const none = ids.filter((x) => !statusOf(x).key);
        if (none.length || !getSettings().autoStatus) groups.push({ key: 'status:', icon: '◌', name: '미분류', color: null, ids: sortIds(none) });
    } else {
        linesFor().forEach((l, i) => {
            groups.push({ key: `line:${l.id}`, badge: i + 1, name: l.name, color: l.color, line: l, ids: sortIds(ids.filter((x) => entry(x).line === l.id)) });
        });
        groups.push({ key: 'line:', icon: '◌', name: '노선 미배정', color: null, ids: sortIds(ids.filter((x) => !lineById(entry(x).line))) });
    }
    return groups;
}

function flatRowHtml(id, cur, color) {
    const c = state.byId.get(id);
    const e = entry(id);
    const isCur = id === cur;
    const cls = ['kts-row', 'flat'];
    if (id === state.selectedId) cls.push('sel');
    if (state.checked.has(id)) cls.push('checked');
    const parent = parentOf(id);
    const tags = [];
    if (isCur) tags.push('<span class="kts-tag now">📍 현위치</span>');
    if (state.selectMode && state.reasons.has(id)) tags.push(`<span class="kts-tag reason">🧹 ${esc(state.reasons.get(id))}</span>`);
    if (viewMode() === 'line') tags.push(statusIcon(id));
    if (viewMode() === 'status') tags.push(lineBadge(e.line));
    const kids = (state.children.get(id) || []).length;
    const check = state.selectMode ? `<span class="kts-check ${isCur ? 'disabled' : ''}">${state.checked.has(id) ? '✓' : ''}</span>` : '';
    return `<div class="${cls.join(' ')}" data-act="select" data-id="${esc(id)}" draggable="true">
        ${check}<span class="kts-dot ${isCur ? 'now' : ''} ${kids ? 'xfer' : ''}" style="--c:${color || 'var(--kts-rail-strong)'}"></span>
        <div class="kts-row-body">
            ${e.pinned ? '<span class="kts-pin">⭐</span>' : ''}
            <div class="tt"><span class="${hasTitle(id) ? 't' : 't none'}">${esc(title(id))}</span>
            ${parent ? `<small>⇄ ${esc(cut(title(parent), 22))}에서 갈라짐</small>` : (kids ? `<small>⇄ 지선 ${kids}개</small>` : '')}</div>
            ${tags.join('')}
            <span class="m">💬 ${c.count} · 🚇 ${fmtYmd(c.lastDate)}</span>
        </div>
    </div>`;
}

function groupedHtml(cur) {
    const groups = groupedOrder();
    const total = groups.reduce((n, g) => n + g.ids.length, 0);
    const out = groups.map((g) => {
        const closed = state.groupCollapsed.has(g.key);
        const editing = g.line && state.lineEdit === g.line.id;
        const mark = g.badge ? `<span class="kts-lnb" style="--c:${g.color}">${g.badge}</span>` : `<span class="kts-gico">${g.icon}</span>`;
        const name = editing
            ? `<input class="kts-ln-input" id="kts-line-name" value="${esc(g.name)}" maxlength="24"><button class="kts-mini" data-act="line-rename-save" data-v="${esc(g.line.id)}">저장</button>`
            : `<b>${esc(g.name)}</b><small>${g.ids.length}</small>`;
        const tools = g.line && !editing ? `<span class="tools"><button class="kts-mini" data-act="line-rename" data-v="${esc(g.line.id)}" title="이름 바꾸기">✏️</button><button class="kts-mini" data-act="line-delete" data-v="${esc(g.line.id)}" title="노선 없애기 (챗은 그대로)">🗑️</button></span>` : '';
        const rows = closed ? '' : (g.ids.length ? g.ids.map((x) => flatRowHtml(x, cur, g.color)).join('') : '<div class="kts-drop-hint">여기로 역을 끌어다 놓으세요</div>');
        return `<section class="kts-grp ${closed ? 'closed' : ''}" data-drop="${esc(g.key)}" style="--c:${g.color || 'var(--kts-rail-strong)'}">
            <header data-act="group-toggle" data-v="${esc(g.key)}">${mark}${name}${tools}<span class="car">${closed ? '▸' : '▾'}</span></header>
            ${rows}
        </section>`;
    }).join('');
    const add = viewMode() === 'line' ? '<button class="kts-addline" data-act="line-add">＋ 새 노선 만들기</button>' : '';
    return (total || viewMode() === 'line' ? out : '<div class="kts-empty small">조건에 맞는 역이 없어요.</div>') + add;
}

export function lineBadge(lineId, withName = false) {
    const l = lineById(lineId);
    if (!l) return '';
    const n = linesFor().indexOf(l) + 1;
    return `<span class="kts-lnb" style="--c:${l.color}" title="${esc(l.name)}">${n}</span>${withName ? `<span class="kts-lnn">${esc(l.name)}</span>` : ''}`;
}

async function promptNewLine() {
    const name = await ctx().Popup.show.input('🎨 새 노선 만들기', '노선 이름을 정해주세요. 예: 메인 루트, AU, 막장, 후회공', '');
    if (typeof name !== 'string' || !name.trim()) return null;
    return addLine(name);
}

/** Drag a row onto a group header/section to re-tag it. */
export function mapDragStart(ev) {
    const row = ev.target.closest?.('.kts-row.flat');
    if (!row) return false;
    ev.dataTransfer.setData('text/plain', row.dataset.id);
    ev.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    return true;
}

export function mapDragOver(ev) {
    const sec = ev.target.closest?.('[data-drop]');
    if (!sec) return false;
    ev.preventDefault();
    document.querySelectorAll('#kts-root .kts-grp.over').forEach((x) => x !== sec && x.classList.remove('over'));
    sec.classList.add('over');
    return true;
}

export function mapDrop(ev) {
    const sec = ev.target.closest?.('[data-drop]');
    document.querySelectorAll('#kts-root .kts-grp.over').forEach((x) => x.classList.remove('over'));
    if (!sec) return false;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    if (!state.byId.has(id)) return true;
    const ids = state.selectMode && state.checked.has(id) ? [...state.checked] : [id];
    const [kind, value] = sec.dataset.drop.split(':');
    for (const x of ids) {
        if (kind === 'status') setEntry(x, { status: value || undefined });
        else setEntry(x, { line: value || undefined });
    }
    if (ids.length > 1) toastr.success(`${ids.length}개 역을 옮겼어요.`, TOAST);
    buildTree();
    app.render();
    return true;
}

// ---------------------------------------------------------------- list rendering

export function laneColor(depth, ancestors) {
    if (depth === 0) return 'var(--kts-rail)';
    return state.groupColor.get(ancestors[depth - 1]) || 'var(--kts-rail)';
}

function trackSvg(row, maxDepth, isCurrent) {
    // each row is only as wide as its own lanes, so one deep branch somewhere doesn't squeeze every title
    const w = LANE_X0 * 2 + Math.min(row.depth, maxDepth) * LANE_W;
    const h = ROW_H;
    const mid = h / 2;
    const x = (l) => LANE_X0 + l * LANE_W;
    const parts = [];
    const sw = 4;
    for (let l = 0; l < row.depth; l++) {
        if (row.cont[l]) parts.push(`<line x1="${x(l)}" y1="0" x2="${x(l)}" y2="${h}" stroke="${laneColor(l, row.ancestors)}" stroke-width="${sw}"/>`);
    }
    const own = laneColor(row.depth, row.ancestors);
    const d = row.depth;
    if (d === 0) {
        if (!row.first) parts.push(`<line x1="${x(0)}" y1="0" x2="${x(0)}" y2="${mid}" stroke="${own}" stroke-width="${sw}"/>`);
    } else if (row.first) {
        parts.push(`<path d="M${x(d - 1)} 0 C${x(d - 1)} ${mid * 0.9} ${x(d)} ${mid * 0.3} ${x(d)} ${mid}" fill="none" stroke="${own}" stroke-width="${sw}" stroke-linecap="round"/>`);
    } else {
        parts.push(`<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${mid}" stroke="${own}" stroke-width="${sw}"/>`);
    }
    if (row.hasKids && row.last) {
        parts.push(`<line x1="${x(d)}" y1="${mid}" x2="${x(d)}" y2="${h}" stroke="${state.groupColor.get(row.id) || own}" stroke-width="${sw}"/>`);
    } else if (!row.last) {
        parts.push(`<line x1="${x(d)}" y1="${mid}" x2="${x(d)}" y2="${h}" stroke="${own}" stroke-width="${sw}"/>`);
    }
    const isXfer = (state.children.get(row.id) || []).length > 0;
    if (isCurrent) {
        parts.push(`<circle cx="${x(d)}" cy="${mid}" r="11" fill="var(--kts-now-halo)"/><circle cx="${x(d)}" cy="${mid}" r="6.5" fill="var(--kts-now)" stroke="var(--kts-station)" stroke-width="2.5"/>`);
    } else if (isXfer) {
        parts.push(`<circle cx="${x(d)}" cy="${mid}" r="8.5" fill="var(--kts-station)" stroke="var(--kts-ink)" stroke-width="2.5"/><circle cx="${x(d)}" cy="${mid}" r="3.2" fill="var(--kts-ink)"/>`);
    } else {
        parts.push(`<circle cx="${x(d)}" cy="${mid}" r="5.5" fill="var(--kts-station)" stroke="${own}" stroke-width="3"/>`);
    }
    return `<svg class="kts-track" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${parts.join('')}</svg>`;
}

function rowHtml(row, maxDepth, cur) {
    const c = state.byId.get(row.id);
    const e = entry(row.id);
    const kids = state.children.get(row.id) || [];
    const isCur = row.id === cur;
    const cls = ['kts-row'];
    if (row.id === state.selectedId) cls.push('sel');
    if (row.dim) cls.push('dim');
    if (state.checked.has(row.id)) cls.push('checked');
    const tags = [];
    if (isCur) tags.push('<span class="kts-tag now">📍 현위치</span>');
    if (state.selectMode && state.reasons.has(row.id)) tags.push(`<span class="kts-tag reason">🧹 ${esc(state.reasons.get(row.id))}</span>`);
    if (kids.length) {
        const collapsed = state.collapsed.has(row.id) && !isFiltering();
        tags.push(`<span class="kts-tag xfer" data-act="toggle" data-id="${esc(row.id)}" style="--c:${state.groupColor.get(row.id)}" title="지선 접기/펼치기">⇄ 환승 ${kids.length} ${collapsed ? '▸' : '▾'}</span>`);
    }
    if (e.transferFrom) tags.push('<span class="kts-tag ticket" title="환승 승차권으로 옮겨온 챗">🎫</span>');
    if (c.orphan) tags.push('<span class="kts-tag warn" title="원본 챗을 찾을 수 없어요">원본 없음</span>');
    const status = statusIcon(row.id);
    const pin = e.pinned ? '<span class="kts-pin">⭐</span>' : '';
    const byMade = state.sort === 'made' || state.sort === 'madeOld';
    const metaDate = byMade ? (c.createdExact ? `🆕 ${fmtYmd(c.created)}` : '') : `🚇 ${fmtYmd(c.lastDate)}`;
    const meta = row.depth === 0 || byMade ? [`💬 ${c.count}`, metaDate].filter(Boolean).join(' · ') : `💬 ${c.count}`;
    const check = state.selectMode ? `<span class="kts-check ${isCur ? 'disabled' : ''}">${state.checked.has(row.id) ? '✓' : ''}</span>` : '';
    return `<div class="${cls.join(' ')}" data-act="select" data-id="${esc(row.id)}">
        ${check}${trackSvg(row, maxDepth, isCur)}
        <div class="kts-row-body">
            ${pin}<span class="${hasTitle(row.id) ? 't' : 't none'}">${esc(title(row.id))}</span>${status}${lineBadge(e.line)}
            ${tags.join('')}
            <span class="m">${meta}</span>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- 🚇 horizontal view
// The main line runs left → right through the root chats; each branch leaves its station on a curve
// and runs on its own track above or below, like a real subway map.

const RAIL_DX = 118;
const RAIL_DY = 64;

/** The horizontal map as markup, for the poster even when another view is on screen. */
export function railSvgHtml() {
    return railHtml(currentChatId());
}

function railHtml(cur) {
    const { rows } = flatten();
    if (!rows.length) return '<div class="kts-empty small">조건에 맞는 역이 없어요.</div>';
    // track (vertical offset) of every station: roots on 0, branches alternate below / above their parent
    const track = new Map();
    const used = new Map(); // track -> last x index used, to keep tracks from crossing stations
    const pos = new Map();
    rows.forEach((r, i) => {
        let t = 0;
        if (r.depth > 0) {
            const parent = r.ancestors[r.ancestors.length - 1];
            const pt = track.get(parent) ?? 0;
            if (r.chain) t = pt;
            else {
                const sibs = state.children.get(parent) || [];
                const k = Math.max(0, sibs.indexOf(r.id));
                const dir = pt === 0 ? (k % 2 === 0 ? 1 : -1) : Math.sign(pt);
                t = pt + dir;
                // step further out while that track is still busy right next to us
                while ((used.get(t) ?? -9) >= i - 1 && Math.abs(t) < 12) t += dir;
            }
        }
        track.set(r.id, t);
        used.set(t, i);
        pos.set(r.id, { x: 50 + i * RAIL_DX, t });
    });
    const ts = [...track.values()];
    const up = Math.max(0, -Math.min(0, ...ts));
    const down = Math.max(0, ...ts);
    const H = 70 + (up + down) * RAIL_DY + 60;
    const y = (t) => 50 + (t + up) * RAIL_DY;
    const W = 100 + rows.length * RAIL_DX;
    const parts = [];
    // main line through the roots
    const roots = rows.filter((r) => r.depth === 0);
    if (roots.length) parts.push(`<line x1="20" y1="${y(0)}" x2="${W - 20}" y2="${y(0)}" stroke="var(--kts-rail)" stroke-width="7" stroke-linecap="round"/>`);
    for (const r of rows) {
        if (r.depth === 0) continue;
        const parent = r.ancestors[r.ancestors.length - 1];
        const a = pos.get(parent);
        const b = pos.get(r.id);
        if (!a) continue;
        const color = state.groupColor.get(parent) || 'var(--kts-accent)';
        const x1 = a.x; const y1 = y(a.t); const x2 = b.x; const y2 = y(b.t);
        const bend = Math.min(60, (x2 - x1) / 2);
        parts.push(`<path d="M${x1} ${y1} C${x1 + bend} ${y1} ${x1 + bend} ${y2} ${x1 + bend * 1.6} ${y2} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`);
    }
    for (const r of rows) {
        const p = pos.get(r.id);
        const cy = y(p.t);
        const isCur = r.id === cur;
        const sel = r.id === state.selectedId;
        const xfer = (state.children.get(r.id) || []).length > 0;
        const ring = r.depth === 0 ? 'var(--kts-ink)' : (state.groupColor.get(r.ancestors[r.ancestors.length - 1]) || 'var(--kts-accent)');
        const dot = isCur
            ? `<circle cx="${p.x}" cy="${cy}" r="13" fill="var(--kts-now-halo)"/><circle cx="${p.x}" cy="${cy}" r="8" fill="var(--kts-now)" stroke="var(--kts-station)" stroke-width="3"/>`
            : xfer
                ? `<circle cx="${p.x}" cy="${cy}" r="10" fill="var(--kts-station)" stroke="var(--kts-ink)" stroke-width="3"/><circle cx="${p.x}" cy="${cy}" r="3.6" fill="var(--kts-ink)"/>`
                : `<circle cx="${p.x}" cy="${cy}" r="7" fill="var(--kts-station)" stroke="${ring}" stroke-width="3.5"/>`;
        const above = p.t < 0;
        const ty = above ? cy - 17 : cy + 25;
        const name = cut(title(r.id), 9);
        const c = state.byId.get(r.id);
        parts.push(`<g class="kts-rail-st ${sel ? 'sel' : ''} ${r.dim ? 'dim' : ''}" data-act="select" data-id="${esc(r.id)}">
            ${sel ? `<rect x="${p.x - 54}" y="${above ? cy - 34 : cy - 14}" width="108" height="${above ? 48 : 58}" rx="12" fill="var(--kts-hover)"/>` : ''}
            ${dot}
            <text x="${p.x}" y="${ty}" text-anchor="middle" class="nm ${hasTitle(r.id) ? '' : 'none'}">${esc(name)}</text>
            <text x="${p.x}" y="${above ? ty - 15 : ty + 15}" text-anchor="middle" class="mt">💬${c.count}${xfer ? ` · ⇄${(state.children.get(r.id) || []).length}` : ''}</text>
        </g>`);
    }
    return `<div class="kts-rail-wrap"><svg class="kts-rail" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg></div>`;
}

function quoteLast(text) {
    const t = cut(text, 180);
    return /^["“'‘「『]/.test(t) ? esc(t) : `“${esc(t)}”`;
}

function siblingsOf(id) {
    if (!state.byId.has(id)) return [];
    if (isRoot(id)) return state.roots;
    return state.children.get(state.byId.get(id).parent) || [];
}

// ---------------------------------------------------------------- detail

const PEEK_COUNT = 8;

function peekHtml(id, c) {
    const pk = state.peek && state.peek.id === id ? state.peek : null;
    const btn = `<button class="kts-peek-btn" data-act="peek">💬 최근 대화 ${pk ? '접기 ▴' : `미리 읽기 (${Math.min(PEEK_COUNT, c.count)}개) ▾`}</button>`;
    if (!pk) {
        const last = lastLine(id, c);
        return `${last ? `<div class="kts-last">${quoteLast(last)}</div>` : ''}${btn}`;
    }
    if (pk.loading) return `${btn}<div class="kts-peek"><div class="kts-muted">대화 불러오는 중…</div></div>`;
    if (pk.error) return `${btn}<div class="kts-peek"><div class="warn">대화를 불러오지 못했어요.</div></div>`;
    const total = pk.total;
    const rows = pk.msgs.map((m, i) => {
        const no = total - pk.msgs.length + i;
        const who = m.extra?.type === 'narrator' ? 'sys' : m.is_user ? 'me' : 'ai';
        return `<div class="kts-pk ${who} ${m.is_system ? 'hid' : ''}"><small>#${no} · ${esc(m.name || '')}${m.is_system ? ' · 숨김' : ''}</small><p>${esc(cut(shownText(m), 420))}</p></div>`;
    }).join('');
    return `${btn}<div class="kts-peek">${rows}</div>`;
}

// The chat list API only returns the raw last message; load the chat once to show its translation.
function lastLine(id, c) {
    const key = `${state.avatar}|${id}|${c.count}`;
    const hit = state.tails.get(key);
    if (hit !== undefined) return hit === 'loading' ? c.lastMes : hit;
    state.tails.set(key, 'loading');
    loadChat(id).then((msgs) => {
        const m = [...msgs].reverse().find((x) => !x.is_system) || msgs[msgs.length - 1];
        state.tails.set(key, m ? shownText(m) : c.lastMes);
        if (m?.extra?.display_text) app.render();
    }).catch(() => state.tails.set(key, c.lastMes));
    return c.lastMes;
}

async function togglePeek(id) {
    if (state.peek?.id === id) { state.peek = null; app.render(); return; }
    const pk = { id, loading: true };
    state.peek = pk;
    app.render();
    try {
        const msgs = await loadChat(id);
        pk.total = msgs.length;
        pk.msgs = msgs.slice(-PEEK_COUNT);
    } catch (err) {
        console.warn(LOG, err);
        pk.error = true;
    }
    pk.loading = false;
    if (state.peek === pk) app.render();
}

function detailHtml(cur) {
    const id = state.selectedId;
    const c = state.byId.get(id);
    if (!c) return '<div class="kts-empty">왼쪽 노선도에서 역을 골라주세요 🚉</div>';
    const e = entry(id);
    const root = isRoot(id);
    const kids = state.children.get(id) || [];
    const parentId = parentOf(id);
    const lineColor = root ? (state.groupColor.get(id) || 'var(--kts-rail-strong)') : (state.groupColor.get(parentId) || 'var(--kts-rail-strong)');
    const sibs = siblingsOf(id);
    const idx = sibs.indexOf(id);
    const prev = idx > 0 ? sibs[idx - 1] : null;
    const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
    const no = branchNo(id);
    const badge = root ? '본' : (no ?? idx + 1);
    const lineName = root ? (kids.length ? '본선 · 환승역' : '본선') : `${cut(title(parentId), 18)} 지선`;
    const isCur = id === cur;
    const busy = state.summarizing.has(id);

    const xfer = [];
    if (parentId) xfer.push(`⇄ <a data-act="goto" data-id="${esc(parentId)}">${esc(title(parentId))}</a>에서 환승${no !== null ? ` · Branch #${no}` : ''}`);
    if (kids.length) xfer.push(`⇄ 환승역 · 지선 ${kids.length}개`);
    if (e.transferFrom) {
        const t = e.transferFrom;
        const sameBot = t.avatar === state.avatar;
        const link = sameBot && state.byId.has(t.id) ? `<a data-act="goto" data-id="${esc(t.id)}">${esc(t.title || fallbackTitle(t.id))}</a>` : `<b>${esc(t.title || fallbackTitle(t.id))}</b>`;
        xfer.push(`🎫 ${sameBot ? '' : `${esc(t.charName || '')} · `}${link}에서 환승 승차권으로 옮겨옴 (#${t.range?.[0]}–#${t.range?.[1]})`);
    }
    if (c.orphan) xfer.push(`<span class="warn">⚠️ 원본 챗 「${esc(c.parent)}」을 찾을 수 없어요</span>`);

    const staleBy = e.summary && e.summarizedCount ? c.count - e.summarizedCount : 0;
    let summaryBlock;
    if (state.editing) {
        summaryBlock = `<div class="kts-edit">
            <label>역 이름</label>
            <input id="kts-edit-title" type="text" maxlength="60" value="${esc(e.title || '')}" placeholder="${esc(fallbackTitle(id))}">
            <label>요약</label>
            <textarea id="kts-edit-summary" rows="5" placeholder="이 챗이 어떤 내용인지 적어두세요">${esc(e.summary || '')}</textarea>
            <div class="kts-edit-btns"><button class="kts-b p" data-act="edit-save">저장</button><button class="kts-b" data-act="edit-cancel">취소</button></div>
        </div>`;
    } else {
        const text = busy ? '<span class="kts-muted">🤖 요약하는 중이에요…</span>'
            : (e.summary ? esc(e.summary) : '<span class="kts-muted">아직 요약이 없어요. 🤖 요약하기를 눌러보세요.</span>');
        const stale = staleBy >= 10 ? `<span class="kts-stale">요약 후 메시지 ${staleBy}개 추가됨 · 다시 요약 추천</span>` : '';
        summaryBlock = `<div class="kts-sum">${text}</div>
            <div class="kts-sum-links"><a data-act="edit">✏️ 고치기</a> · <a data-act="summarize" class="${busy ? 'off' : ''}">🤖 ${e.summary ? '다시 요약' : '요약하기'}</a>${stale}</div>`;
    }

    const statusChips = Object.entries(STATUS).map(([k, v]) =>
        `<button class="kts-chip ${e.status === k ? 'on' : (statusOf(id).auto && statusOf(id).key === k ? 'auto' : '')}" data-act="status" data-v="${k}" title="${statusOf(id).auto && statusOf(id).key === k ? '자동으로 붙은 태그예요. 누르면 직접 고정돼요' : ''}">${v.icon} ${v.label}${statusOf(id).auto && statusOf(id).key === k ? ' <small>자동</small>' : ''}</button>`).join('')
        + `<button class="kts-chip ${e.pinned ? 'on' : ''}" data-act="pin">⭐ 즐겨찾기</button>`;

    return `<div class="kts-detail-inner">
        <button class="kts-back" data-act="back">← 노선도</button>
        <div class="kts-sign" style="--line:${lineColor}">
            <div class="ln"><b>${esc(badge)}</b>${esc(lineName)}</div>
            <h2>${esc(title(id))}</h2>
            <div class="nb">
                ${prev ? `<a data-act="goto" data-id="${esc(prev)}">◀ ${esc(cut(title(prev), 14))}</a>` : '<span></span>'}
                ${next ? `<a data-act="goto" data-id="${esc(next)}">${esc(cut(title(next), 14))} ▶</a>` : '<span></span>'}
            </div>
        </div>
        <div class="kts-body">
            ${xfer.length ? `<div class="kts-xf">${xfer.join('<br>')}</div>` : ''}
            ${summaryBlock}
            <div class="kts-chips">${statusChips}</div>
            <div class="kts-chips lines"><span class="lbl">🎨 노선</span>${linesFor().map((l, i) => `<button class="kts-chip ln ${e.line === l.id ? 'on' : ''}" style="--c:${l.color}" data-act="line-assign" data-v="${esc(l.id)}"><span class="kts-lnb" style="--c:${l.color}">${i + 1}</span>${esc(l.name)}</button>`).join('')}<button class="kts-chip add" data-act="line-new-assign">＋ 새 노선</button></div>
            <div class="kts-stats">
                <div><div>메시지</div><b>${c.count}개</b></div>
                <div><div>크기</div><b>${esc(c.sizeText || '-')}</b></div>
                <div><div>마지막 탑승</div><b>${fmtLong(c.lastDate)}</b></div>
                ${c.createdExact ? `<div><div>처음 생성</div><b>${fmtLong(c.created)}</b></div>` : ''}
            </div>
            ${parentId ? divergenceHtml(id, parentId) : ''}
            ${peekHtml(id, c)}
            ${compareHtml(id)}
            <div class="kts-file" title="파일 이름">🗂️ ${esc(id)}.jsonl</div>
            <div class="kts-btns">
                <button class="kts-b p" data-act="open" ${isCur ? 'disabled' : ''}>${isCur ? '📍 지금 탑승 중' : '🚇 이 노선 탑승'}</button>
                <button class="kts-b tk" data-act="ticket">🎫 환승 승차권</button>
                <button class="kts-b" data-act="compare-open" title="다른 역과 무엇이 달라졌는지 비교해요">⚖️ 비교</button>
                <button class="kts-b" data-act="edit">이름 바꾸기</button>
                <button class="kts-b" data-act="download-one" title="이 챗 원본(.jsonl)을 내려받아요">⬇️ 다운로드</button>
                <button class="kts-b" data-act="hide-range" title="몇 번부터 몇 번까지 메시지를 숨겨요">🙈 숨기기</button>
                <button class="kts-b" data-act="show-range" title="숨긴 메시지를 범위를 정해서 다시 보이게 해요">👁️ 보이기</button>
                <button class="kts-b d" data-act="delete-one" ${isCur ? 'disabled title="지금 열린 챗은 폐역할 수 없어요"' : ''}>폐역</button>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- toolbar / legend / footer

function toolbarHtml() {
    const unsummarized = state.list.filter((c) => !entry(c.id).summary).length;
    const bulkBtn = state.bulk
        ? `<button class="kts-pill on" data-act="bulk-stop">⏹ 요약 중지 (${state.bulk.done}/${state.bulk.total})</button>`
        : (unsummarized ? `<button class="kts-pill" data-act="bulk" title="요약 없는 역을 모두 요약해요">🤖 요약 ${unsummarized}</button>` : '');
    const sorts = { recent: '최근 탑승순', old: '오래 안 탄 순', made: '최근 생성순', madeOld: '처음 생성순', size: '크기순', count: '메시지순' };
    const sortOpts = Object.entries(sorts).map(([k, v]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${v}</option>`).join('');
    const other = !isOpenCharView() && openChar() ? `<button class="kts-pill" data-act="map-home" title="지금 열린 캐릭터의 노선도로">↩ ${esc(cut(openChar().name, 10))}</button>` : '';
    return `<div class="kts-toolbar">
        <span class="kts-cur">${esc(state.charName)} <small>역 ${state.list.length}개</small></span>
        ${other}
        <input class="kts-search" id="kts-search" type="search" placeholder="🔍 역 이름, 요약으로 찾기" value="${esc(state.query)}">
        <select class="kts-pill kts-sort" id="kts-sort" title="본선 정렬">${sortOpts}</select>
        ${bulkBtn}
        ${!state.bulk && !unsummarized && state.list.length ? '<button class="kts-pill" data-act="bulk-all" title="모든 역의 요약을 새 방식으로 다시 써요">🤖 전부 다시 요약</button>' : ''}
        <button class="kts-pill" data-act="wash-open" title="고르지 않은 스와이프와 추론 기록을 지워서 챗을 가볍게 해요 (선택 모드에서 고른 역만 할 수도 있어요)">🧽 객차 청소</button>
        <button class="kts-pill" data-act="rel-open" title="챗에 나온 인물들의 관계를 노선도로 보여줘요">🕸️ 관계도</button>
        <button class="kts-pill" data-act="poster" title="노선도를 PNG 포스터로 저장">🖼️ 포스터</button>
        <button class="kts-pill" data-act="download-bot" ${state.dlBusy ? 'disabled' : ''} title="이 봇의 모든 역(.jsonl)과 제목·요약을 zip 하나로 받아요">${state.dlBusy ? `💾 ${state.dlBusy}` : '💾 전체 백업'}</button>
        <button class="kts-pill ${state.selectMode ? 'on' : ''}" data-act="select-mode">${state.selectMode ? '선택 끝' : '선택'}</button>
    </div>`;
}

function legendHtml() {
    const f = (k, label) => `<button class="kts-f ${state.filter === k ? 'on' : ''}" data-act="filter" data-v="${k}">${label}</button>`;
    const mode = viewMode();
    const views = [['tree', '🌳 트리'], ['rail', '🚇 가로'], ['status', '🗂️ 상태별'], ['line', '🎨 노선별']]
        .map(([k, v]) => `<button class="${mode === k ? 'on' : ''}" data-act="view-mode" data-v="${k}">${v}</button>`).join('');
    const lines = linesFor();
    const lf = (v, html, color) => `<button class="kts-f ln ${state.lineFilter === v ? 'on' : ''}" data-act="line-filter" data-v="${esc(v ?? '')}" ${color ? `style="--c:${color}"` : ''}>${html}</button>`;
    const lineRow = mode !== 'line' && lines.length
        ? `<div class="kts-legend lines"><span class="lbl">🎨 내 노선</span>${lf(null, '전체')}${lines.map((l, i) => lf(l.id, `<span class="kts-lnb" style="--c:${l.color}">${i + 1}</span>${esc(l.name)}`)).join('')}${lf('none', '미배정')}</div>`
        : '';
    return `<div class="kts-legend">
        <span class="kts-seg sm">${views}</span>
        ${mode === 'tree' || mode === 'rail' ? `<span class="lg"><i style="background:var(--kts-rail)"></i>본선</span>
        <span class="lg"><i style="background:${LINE_COLORS[0]}"></i><i style="background:${LINE_COLORS[1]}"></i>지선</span>
        <span class="lg">⇄ 환승역</span>` : `<span class="lg">${mode === 'status' ? '역을 끌어서 다른 칸에 놓으면 상태가 바뀌어요' : '역을 끌어서 노선에 넣어요 · 선택한 여러 역도 한 번에'}</span>`}
        <span class="kts-filters">${f('all', '전체')}${f('pin', '⭐')}${Object.entries(STATUS).map(([k, v]) => f(k, v.icon)).join('')}</span>
    </div>${lineRow}`;
}

function footerHtml() {
    if (!state.selectMode) return '';
    const n = state.checked.size;
    return `<div class="kts-foot">
        <span>${n}개 선택됨 <small class="kts-hint">· Shift+클릭으로 범위 선택</small></span>
        <select class="kts-b" id="kts-bulk-tag" ${n ? '' : 'disabled'} title="고른 역에 상태 태그를 한 번에 붙여요">
            <option value="">🏷️ 한번에 태그</option>
            ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
            <option value="clear">태그 지우기</option>
            <option value="pin">⭐ 즐겨찾기</option>
            <option value="unpin">⭐ 즐겨찾기 해제</option>
            <optgroup label="🎨 노선으로 보내기">
                ${linesFor().map((l, i) => `<option value="line:${esc(l.id)}">${i + 1} ${esc(l.name)}</option>`).join('')}
                <option value="line:new">＋ 새 노선 만들어서 보내기</option>
                <option value="line:">노선에서 빼기</option>
            </optgroup>
        </select>
        <button class="kts-b" data-act="recommend" title="그리팅만 있는 챗, 시험운행, 짧은 챗, 오래 방치된 챗을 골라줘요 (기준은 ⚙️ 설정)">🧹 폐역 후보 추천</button>
        <select class="kts-b kts-short" id="kts-short" title="메시지가 적은 역을 한 번에 골라요">
            <option value="">💬 짧은 챗</option>
            <option value="2">메시지 2개 이하</option>
            <option value="5">메시지 5개 이하</option>
            <option value="10">메시지 10개 이하</option>
            <option value="20">메시지 20개 이하</option>
        </select>
        <button class="kts-b" data-act="check-visible" title="지금 보이는 역(검색·필터 결과)을 모두 골라요">보이는 역 모두</button>
        <button class="kts-b" data-act="check-none" ${n ? '' : 'disabled'}>선택 해제</button>
        <button class="kts-b d" data-act="delete-checked" ${n ? '' : 'disabled'}>🗑️ ${n}개 폐역</button>
    </div>`;
}

export function mapHtml() {
    if (state.loading && !state.list.length) return '<div class="kts-empty">노선도를 그리는 중… 🚇</div>';
    if (state.error) return `<div class="kts-empty">${esc(state.error)}</div>`;
    if (!state.list.length) return toolbarHtml() + '<div class="kts-empty">아직 챗이 없어요.</div>';
    const cur = currentChatId();
    let list;
    if (viewMode() === 'rail') {
        list = railHtml(cur);
    } else if (viewMode() === 'tree') {
        const { rows, maxDepth } = flatten();
        list = rows.length ? rows.map((r) => rowHtml(r, maxDepth, cur)).join('') : '<div class="kts-empty small">조건에 맞는 역이 없어요.</div>';
    } else {
        list = groupedHtml(cur);
    }
    if (state.selectedId && parentOf(state.selectedId)) ensureDivergence(state.selectedId, parentOf(state.selectedId));
    return toolbarHtml() + legendHtml()
        + `<div class="kts-main ${state.mobileDetail ? 'show-detail' : ''} ${viewMode() === 'rail' ? 'is-rail' : ''}">
            <div class="kts-list ${viewMode() === 'rail' ? 'rail' : viewMode() !== 'tree' ? 'grouped' : ''}">${list}</div>
            <div class="kts-detail">${detailHtml(cur)}</div>
        </div>` + footerHtml();
}

// ---------------------------------------------------------------- actions

async function deleteChats(ids) {
    const cur = currentChatId();
    ids = ids.filter((id) => id !== cur && state.byId.has(id));
    if (!ids.length) return;
    const { Popup, POPUP_RESULT, eventSource, event_types } = ctx();
    const withKids = ids.filter((id) => (state.children.get(id) || []).some((k) => !ids.includes(k)));
    const list = ids.slice(0, 12).map((id) => `<li>${esc(title(id))} <small>(${state.byId.get(id).count}개)</small></li>`).join('')
        + (ids.length > 12 ? `<li>…외 ${ids.length - 12}개</li>` : '');
    const warn = withKids.length ? `<p class="kts-pop-warn">⚠️ 지선이 남아 있는 환승역이 ${withKids.length}개 있어요. 지선들은 남고 '원본 없음'으로 표시돼요.</p>` : '';
    const ok = await Popup.show.confirm(`🗑️ ${ids.length}개 폐역`, `<div class="kts-pop-list"><p>이 챗 파일들을 <b>완전히 삭제</b>해요. 되돌릴 수 없어요.</p><ul>${list}</ul>${warn}</div>`);
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    let done = 0;
    state.deleting = true;
    for (const id of ids) {
        try {
            await deleteChatFile(state.avatar, id);
            delete storeFor()[id];
            state.checked.delete(id);
            done++;
            await eventSource.emit(event_types.CHAT_DELETED, id);
        } catch (err) {
            console.error(LOG, 'delete failed', id, err);
        }
    }
    state.deleting = false;
    save();
    toastr.success(`${done}개 폐역 완료${done < ids.length ? ` · 실패 ${ids.length - done}개` : ''}`, TOAST);
    if (ids.includes(state.selectedId)) state.selectedId = null;
    await app.refresh();
}

function saveEdit() {
    const id = state.selectedId;
    const t = document.getElementById('kts-edit-title')?.value.trim() ?? '';
    const s = document.getElementById('kts-edit-summary')?.value.trim() ?? '';
    setEntry(id, { title: t, summary: s, titleLocked: !!t });
    state.editing = false;
    buildTree();
    app.render();
}

export function mapSaveEdit() { saveEdit(); }

function select(id) {
    state.selectedId = id;
    state.editing = false;
    state.compare = null;
    state.peek = null;
    state.mobileDetail = true;
    app.render();
}

/** @returns {Promise<boolean>} true when handled */
export async function mapClick(act, el, ev) {
    const id = el.dataset.id;
    switch (act) {
        case 'toggle':
            if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
            app.render();
            return true;
        case 'select':
            if (state.selectMode) {
                if (id === currentChatId()) { toastr.info('지금 열린 챗은 폐역할 수 없어요.'); return true; }
                if (ev.shiftKey && state.lastCheckedId && state.lastCheckedId !== id) {
                    const ids = visibleIds();
                    const a = ids.indexOf(state.lastCheckedId);
                    const b = ids.indexOf(id);
                    if (a >= 0 && b >= 0) {
                        const cur = currentChatId();
                        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) if (x !== cur) state.checked.add(x);
                    }
                } else if (state.checked.has(id)) {
                    state.checked.delete(id);
                } else {
                    state.checked.add(id);
                }
                state.lastCheckedId = id;
                state.selectedId = id;
                app.render();
            } else {
                select(id);
            }
            return true;
        case 'goto': select(id); return true;
        case 'peek': await togglePeek(state.selectedId); return true;
        case 'view-mode': getSettings().viewMode = el.dataset.v; save(); app.render(); return true;
        case 'line-filter': state.lineFilter = el.dataset.v || null; app.render(); return true;
        case 'group-toggle': {
            if (ev.target.closest('button, input')) return true;
            const k = el.dataset.v;
            if (state.groupCollapsed.has(k)) state.groupCollapsed.delete(k); else state.groupCollapsed.add(k);
            app.render();
            return true;
        }
        case 'line-add': if (await promptNewLine()) app.render(); return true;
        case 'line-assign': {
            const v = el.dataset.v;
            setEntry(state.selectedId, { line: entry(state.selectedId).line === v ? undefined : v });
            app.render();
            return true;
        }
        case 'line-new-assign': {
            const l = await promptNewLine();
            if (l) { setEntry(state.selectedId, { line: l.id }); app.render(); }
            return true;
        }
        case 'line-rename': state.lineEdit = el.dataset.v; app.render(); document.getElementById('kts-line-name')?.select(); return true;
        case 'line-rename-save': {
            const l = lineById(el.dataset.v);
            const v = document.getElementById('kts-line-name')?.value.trim();
            if (l && v) { l.name = v.slice(0, 24); save(); }
            state.lineEdit = null;
            app.render();
            return true;
        }
        case 'line-delete': {
            const l = lineById(el.dataset.v);
            if (!l) return true;
            const ok = await ctx().Popup.show.confirm('🎨 노선 없애기', `「${esc(l.name)}」 노선을 없앨까요?<br><small>챗은 지워지지 않고 '노선 미배정'으로 돌아가요.</small>`);
            if (ok === ctx().POPUP_RESULT.AFFIRMATIVE) {
                removeLine(l.id);
                if (state.lineFilter === l.id) state.lineFilter = null;
                app.render();
            }
            return true;
        }
        case 'bulk-all': await bulkSummarize({ all: true }); return true;
        case 'back': state.mobileDetail = false; app.render(); return true;
        case 'filter': state.filter = el.dataset.v; app.render(); return true;
        case 'select-mode':
            state.selectMode = !state.selectMode;
            if (!state.selectMode) { state.checked.clear(); state.reasons.clear(); }
            app.render();
            return true;
        case 'check-none': state.checked.clear(); state.reasons.clear(); app.render(); return true;
        case 'check-visible': {
            const cur = currentChatId();
            for (const x of visibleIds()) if (x !== cur) state.checked.add(x);
            app.render();
            return true;
        }
        case 'recommend': recommendCandidates(); return true;
        case 'delete-checked': await deleteChats([...state.checked]); return true;
        case 'delete-one': await deleteChats([state.selectedId]); return true;
        case 'open': {
            const target = state.selectedId;
            app.closePopup();
            try { await openChatOf(state.avatar, target); } catch (err) { console.error(LOG, err); toastr.error('챗을 열지 못했어요.', TOAST); }
            return true;
        }
        case 'edit': state.editing = true; app.render(); return true;
        case 'edit-cancel': state.editing = false; app.render(); return true;
        case 'edit-save': saveEdit(); return true;
        case 'summarize': if (!state.summarizing.has(state.selectedId)) await summarize(state.selectedId); return true;
        case 'status': {
            const v = el.dataset.v;
            // tapping your own tag again clears it (back to automatic); tapping an automatic one pins it
            setEntry(state.selectedId, { status: entry(state.selectedId).status === v ? undefined : v });
            app.render();
            return true;
        }
        case 'pin':
            setEntry(state.selectedId, { pinned: !entry(state.selectedId).pinned });
            buildTree();
            app.render();
            return true;
    }
    return false;
}

export async function mapChange(ev) {
    if (ev.target.id === 'kts-bulk-tag') {
        const v = ev.target.value;
        const ids = [...state.checked];
        if (v.startsWith('line:') && ids.length) {
            let lineId = v.slice(5);
            if (lineId === 'new') {
                const l = await promptNewLine();
                if (!l) { app.render(); return true; }
                lineId = l.id;
            }
            for (const x of ids) setEntry(x, { line: lineId || undefined });
            toastr.success(lineId ? `${ids.length}개 역을 「${esc(lineById(lineId)?.name || '')}」 노선에 넣었어요.` : `${ids.length}개 역을 노선에서 뺐어요.`, TOAST, { escapeHtml: false });
            app.render();
            return true;
        }
        if (v && ids.length) {
            for (const x of ids) {
                if (STATUS[v]) setEntry(x, { status: v });
                else if (v === 'clear') setEntry(x, { status: undefined });
                else if (v === 'pin') setEntry(x, { pinned: true });
                else if (v === 'unpin') setEntry(x, { pinned: undefined });
            }
            const label = STATUS[v] ? `${STATUS[v].icon} ${STATUS[v].label}` : { clear: '태그 지우기', pin: '⭐ 즐겨찾기', unpin: '⭐ 해제' }[v];
            toastr.success(`${ids.length}개 역에 「${label}」 적용했어요.`, TOAST);
            buildTree();
        }
        app.render();
        return true;
    }
    if (ev.target.id === 'kts-short') {
        const max = Number(ev.target.value);
        if (max) {
            const cur = currentChatId();
            let added = 0;
            for (const x of visibleIds()) {
                if (x !== cur && state.byId.get(x).count <= max && !state.checked.has(x)) { state.checked.add(x); added++; }
            }
            toastr.info(added ? `메시지 ${max}개 이하인 역 ${added}개를 골랐어요.` : '해당하는 역이 없어요.', TOAST);
        }
        app.render();
        return true;
    }
    if (ev.target.id === 'kts-sort') {
        state.sort = ev.target.value;
        buildTree();
        app.render();
        return true;
    }
    return false;
}
