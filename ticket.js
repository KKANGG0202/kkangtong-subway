// 깡통 노선도 - 🎫 환승 승차권: copy a range of messages (and memories) into a new or existing chat

import {
    TOAST, LOG, state, app, ctx, entry, setEntry, esc, cut, plain, fmtShort, fallbackTitle, title, charByAvatar,
    avatarUrl, openChar, loadChatRaw, shownText, fetchChatList, ensureChatDir, saveChatRaw, openChatOf, errText,
} from './core.js';

const QUICK = [20, 50, 100];

// ---------------------------------------------------------------- helpers

// Messages hidden by ST's /hide or by memory extensions after summarizing them.
const isHidden = (m) => !!m?.is_system && !m?.extra?.type;

function elephantHasContent(mem) {
    return !!mem && ((mem.timeline?.length || 0) > 0 || (mem.ledger?.entries?.length || 0) > 0 || !!mem.saga?.text);
}

// Same transformation as 코끼리를 생각하지마's own "새 채팅으로 이어가기" (carryOver).
function elephantCarry(mem) {
    const m = structuredClone(mem);
    const mark = (x) => { x.from = -1; x.to = -1; return x; };
    (m.timeline || []).forEach((n) => { mark(n); n.stale = false; n.msgCount = 0; n.review = null; });
    (m.events || []).forEach(mark);
    (m.archive || []).forEach(mark);
    (m.hooks || []).forEach((h) => { h.from = -1; if (h.status === 'resolved') h.resolvedAt = -1; });
    if (m.saga) m.saga.coversTo = -1;
    (m.ledger?.entries || []).forEach((e) => { e.updatedAt = -1; });
    (m.cast || []).forEach((member) => {
        (member.quotes || []).forEach((q) => { if (q.at >= 0) q.at = -2; });
        (member.growth || []).forEach((g) => { g.at = -1; });
    });
    Object.assign(m, { cursor: -1, hiddenRanges: [], history: [], opsSinceBackup: 0, tagVersion: 1 });
    return m;
}

const memoriaInstalled = () => !!document.getElementById('memoria_carry_input');
const elephantInstalled = () => typeof globalThis.longMemoryInterceptor === 'function';

function recentBots(exclude) {
    return (ctx().characters || [])
        .filter((c) => c?.avatar && c.avatar !== exclude)
        .sort((a, b) => (Number(b.date_last_chat) || 0) - (Number(a.date_last_chat) || 0))
        .slice(0, 3);
}

function nowStamp() {
    return new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------- open / load

export async function openTicket(srcId) {
    const t = {
        loading: true, srcAvatar: state.avatar, srcName: state.charName, srcId, srcTitle: title(srcId),
        header: null, msgs: [], total: 0, lastHidden: -1, start: 0, end: 0,
        mode: 'new', destAvatar: state.avatar, destName: state.charName, destChats: null, destChat: null, botQuery: '',
        rename: true, go: true, bag: { memoria: false, elephant: false, memo: false }, has: {}, busy: false,
    };
    state.ticket = t;
    state.view = 'ticket';
    app.render();
    try {
        const { header, messages } = await loadChatRaw(srcId, t.srcAvatar);
        t.header = header;
        t.msgs = messages;
        t.total = messages.length;
        messages.forEach((m, i) => { if (isHidden(m)) t.lastHidden = i; });
        t.end = Math.max(0, t.total - 1);
        t.start = t.lastHidden >= 0 && t.lastHidden < t.total - 1 ? t.lastHidden + 1 : Math.max(0, t.total - 20);
        const meta = header?.chat_metadata || {};
        t.has = {
            memoria: !!meta.memoria,
            elephant: elephantHasContent(meta.long_memory),
            memo: !!entry(srcId, t.srcAvatar).summary,
        };
        t.bag.memoria = t.has.memoria && memoriaInstalled();
        t.bag.elephant = t.has.elephant && elephantInstalled();
        t.bag.memo = t.has.memo && !t.bag.memoria && !t.bag.elephant;
        t.loading = false;
        await loadDest(t.destAvatar);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('챗을 불러오지 못했어요.', TOAST);
        closeTicket();
    }
}

async function loadDest(avatar) {
    const t = state.ticket;
    if (!t) return;
    const found = charByAvatar(avatar);
    t.destAvatar = avatar;
    t.destName = found?.char?.name || avatar;
    t.destChats = null;
    t.destChat = null;
    app.render();
    try {
        const list = await fetchChatList(avatar, { metadata: false });
        if (state.ticket !== t || t.destAvatar !== avatar) return;
        t.destChats = list.sort((a, b) => b.lastDate - a.lastDate);
    } catch {
        t.destChats = [];
    }
    app.render();
}

export function closeTicket() {
    state.ticket = null;
    state.view = 'main';
    app.render();
}

// ---------------------------------------------------------------- render

const edge = (p) => (p > 88 ? 'er' : p < 12 ? 'el' : '');

function routeHtml(t) {
    const n = t.total;
    const pct = (i) => (n > 1 ? (i / (n - 1)) * 100 : 0);
    const segs = [];
    // hidden (already summarized) spans = "지나온 역"
    let s = -1;
    for (let i = 0; i <= n; i++) {
        const h = i < n && isHidden(t.msgs[i]);
        if (h && s < 0) s = i;
        if (!h && s >= 0) { segs.push(`<i class="rt-past" style="left:${pct(s)}%;width:${Math.max(pct(i - 1) - pct(s), 0.4)}%"></i>`); s = -1; }
    }
    const dots = n <= 160 ? t.msgs.map((m, i) => `<b class="rt-dot ${isHidden(m) ? 'past' : ''}" style="left:${pct(i)}%"></b>`).join('') : '';
    return `<div class="kts-route" id="kts-route">
        <i class="rt-base"></i>${segs.join('')}
        <i class="rt-sel" style="left:${pct(t.start)}%;width:${pct(t.end) - pct(t.start)}%"></i>
        ${dots}
        <span class="rt-mk start ${edge(pct(t.start))} ${pct(t.end) - pct(t.start) < 22 ? 'up' : ''}" data-mk="start" style="left:${pct(t.start)}%"><em></em><label>🚏 승차 #${t.start}</label></span>
        <span class="rt-mk end ${edge(pct(t.end))}" data-mk="end" style="left:${pct(t.end)}%"><em></em><label>🚩 하차 #${t.end}</label></span>
        ${pct(t.start) > 10 ? '<span class="rt-ax l">#0</span>' : ''}${pct(t.end) < 90 ? `<span class="rt-ax r">#${Math.max(0, n - 1)}</span>` : ''}
    </div>`;
}

function preview(t, i) {
    const m = t.msgs[i];
    if (!m) return '';
    return `<div class="kts-tk-pv"><b>#${i} · ${esc(m.name || '')}</b>${esc(cut(shownText(m), 150))}</div>`;
}

function botCard(t, avatar, sub) {
    const ch = charByAvatar(avatar)?.char;
    if (!ch) return '';
    return `<div class="kts-tk-bot ${t.destAvatar === avatar ? 'on' : ''}" data-act="tk-bot" data-avatar="${esc(avatar)}">
        <img src="${esc(avatarUrl(avatar))}" alt="" loading="lazy"><div>${esc(cut(ch.name, 16))}<small>${esc(sub)}</small></div></div>`;
}

export function ticketHtml() {
    const t = state.ticket;
    if (!t) return '';
    if (t.loading) return '<div class="kts-empty">승차권 준비 중… 🎫</div>';
    const count = t.end - t.start + 1;
    const cross = t.destAvatar !== t.srcAvatar;
    const bagNames = [t.bag.memoria && '메모리아', t.bag.elephant && '코끼리', t.bag.memo && '요약 메모'].filter(Boolean);
    const destLabel = t.mode === 'new' ? '새 노선 개통' : (t.destChat ? title(t.destChat, t.destAvatar) : '도착역을 골라주세요');

    // quick chips
    const chips = [];
    if (t.lastHidden >= 0 && t.lastHidden < t.total - 1) {
        chips.push(`<button class="kts-chip ${t.start === t.lastHidden + 1 && t.end === t.total - 1 ? 'on' : ''}" data-act="tk-quick" data-v="unsum">✨ 요약 안 된 부분부터</button>`);
    }
    for (const q of QUICK) {
        if (q >= t.total) continue;
        chips.push(`<button class="kts-chip ${t.start === t.total - q && t.end === t.total - 1 ? 'on' : ''}" data-act="tk-quick" data-v="${q}">최근 ${q}개</button>`);
    }
    chips.push(`<button class="kts-chip ${t.start === 0 && t.end === t.total - 1 ? 'on' : ''}" data-act="tk-quick" data-v="all">전체</button>`);

    // destination bots
    const q = t.botQuery.trim().toLowerCase();
    let bots;
    if (q) {
        bots = (ctx().characters || []).filter((c) => c?.name?.toLowerCase().includes(q)).slice(0, 6)
            .map((c) => botCard(t, c.avatar, c.avatar === t.srcAvatar ? '출발 봇' : '검색 결과')).join('');
    } else {
        bots = botCard(t, t.srcAvatar, '출발 봇') + recentBots(t.srcAvatar).map((c) => botCard(t, c.avatar, '최근 탑승')).join('');
        if (t.destAvatar !== t.srcAvatar && !recentBots(t.srcAvatar).some((c) => c.avatar === t.destAvatar)) bots += botCard(t, t.destAvatar, '선택한 봇');
    }

    let destList;
    if (!t.destChats) destList = '<div class="kts-muted">노선도 불러오는 중…</div>';
    else {
        const rows = t.destChats.slice(0, 40).map((c) => {
            const e = entry(c.id, t.destAvatar);
            const self = t.destAvatar === t.srcAvatar && c.id === t.srcId;
            const sel = t.mode === 'exist' && t.destChat === c.id;
            return `<div class="kts-tk-row ${sel ? 'on' : ''} ${self ? 'self' : ''} ${t.mode === 'exist' && !self ? 'pick' : ''}" ${t.mode === 'exist' && !self ? `data-act="tk-destchat" data-id="${esc(c.id)}"` : ''}>
                <span class="d"></span><div class="t">${esc(e.title || fallbackTitle(c.id))}${self ? ' <small class="me">출발역</small>' : ''}
                <small>${esc(cut(e.summary || c.lastMes || '', 70))}</small></div><span class="m">${c.count} · ${fmtShort(c.lastDate)}</span></div>`;
        }).join('');
        const newRow = t.mode === 'new' ? `<div class="kts-tk-row new"><span class="d"></span><div class="t">＋ 새 노선 개통<small>「${esc(cut(t.srcTitle, 24))}」에서 환승</small></div></div>` : '';
        destList = newRow + (rows || '<div class="kts-muted">이 봇은 아직 챗이 없어요</div>');
    }

    const bagItem = (k, icon, name, desc, installed) => {
        if (!t.has[k]) return '';
        const off = !installed;
        return `<div class="kts-tk-item ${t.bag[k] ? 'on' : ''} ${off ? 'off' : ''}" ${off ? '' : `data-act="tk-bag" data-v="${k}"`}>
            <span class="ck">${t.bag[k] ? '✓' : ''}</span><div><b>${icon} ${name}</b><small>${off ? '이 확장이 꺼져 있어서 옮길 수 없어요' : desc}</small></div></div>`;
    };
    const bag = bagItem('memoria', '📚', '메모리아 인계', '요약 · 📌고정 기억 · 인물 도감 · 캐논 · 서약을 이어받아요 (메모리아 자체 인계 기능 사용)', memoriaInstalled())
        + bagItem('elephant', '🐘', '코끼리 기억', '줄거리 · 기록부 · 사건 · 캐해를 코끼리 「새 채팅으로 이어가기」와 같은 방식으로 옮겨요', elephantInstalled())
        + bagItem('memo', '🗺️', '노선도 요약 메모', '첫머리에 「지난 줄거리」를 시스템 메모로 붙여요 (기억 확장을 안 쓸 때 추천)', true);

    const forceGo = t.bag.memoria;
    const valid = count > 0 && (t.mode === 'new' || !!t.destChat) && !t.busy;

    return `<div class="kts-tk">
        <div class="kts-tk-head"><button class="kts-pill" data-act="ticket-close">← 노선도</button><b>🎫 환승 승차권 발권</b></div>
        <div class="kts-ticket">
            <div class="main">
                <div class="stn"><small>출발</small><b>${esc(cut(t.srcTitle, 22))}</b><div class="sb">${esc(t.srcName)}</div></div>
                <div class="arrow"><i></i>🚇<i></i></div>
                <div class="stn r"><small>도착</small><b>${esc(cut(destLabel, 22))}</b><div class="sb">${esc(t.destName)}</div></div>
            </div>
            <div class="stub"><span>승차 구간</span><b>#${t.start} – #${t.end}</b>${count}개${bagNames.length ? ` · ${bagNames.join(' · ')}` : ''}</div>
        </div>
        <div class="kts-tk-body">
            <div class="col">
                <div class="sec"><h3><span class="n">1</span>들고 갈 메시지<small>전체 #0 – #${Math.max(0, t.total - 1)}</small></h3>
                    <div class="kts-chips">${chips.join('')}</div>
                    <div class="kts-tk-range"><input id="kts-tk-start" type="number" min="0" max="${t.total - 1}" value="${t.start}"><span>부터</span>
                        <input id="kts-tk-end" type="number" min="0" max="${t.total - 1}" value="${t.end}"><span>까지 · ${count}개</span></div>
                    ${routeHtml(t)}
                    <div class="kts-tk-lg"><span><i class="past"></i>지나온 역 (요약돼서 숨겨진 메시지)</span><span><i class="sel"></i>들고 갈 구간 · 🚏🚩를 끌어서 조절</span></div>
                    ${preview(t, t.start)}${t.end !== t.start ? preview(t, t.end) : ''}
                </div>
                <div class="sec"><h3><span class="n">3</span>짐 싸기 · 기억 들고 가기</h3>
                    ${bag || '<div class="kts-muted">이 챗에는 옮길 기억(메모리아 · 코끼리 · 노선도 요약)이 없어요. 메시지만 옮겨요.</div>'}
                </div>
            </div>
            <div class="col">
                <div class="sec grow"><h3><span class="n">2</span>도착역</h3>
                    <div class="kts-tabs2"><button class="${t.mode === 'new' ? 'on' : ''}" data-act="tk-mode" data-v="new">＋ 새 챗 개통</button><button class="${t.mode === 'exist' ? 'on' : ''}" data-act="tk-mode" data-v="exist">🚉 기존 챗으로</button></div>
                    <div class="kts-tk-bots">${bots}</div>
                    <input class="kts-search small" id="kts-tk-botq" type="search" placeholder="🔍 다른 봇 찾기" value="${esc(t.botQuery)}">
                    <div class="kts-muted small">${t.mode === 'new' ? '이 봇의 노선도 · 새 역이 여기에 생겨요' : '이어 붙일 챗을 골라주세요 · 메시지는 그 챗 끝에 붙어요'}</div>
                    <div class="kts-tk-list">${destList}</div>
                    ${cross ? `<label class="kts-opt"><input type="checkbox" id="kts-tk-rename" ${t.rename ? 'checked' : ''}> AI 메시지 이름 「${esc(cut(t.srcName, 12))}」→「${esc(cut(t.destName, 12))}」로 바꾸기</label>` : ''}
                    <label class="kts-opt"><input type="checkbox" id="kts-tk-go" ${t.go || forceGo ? 'checked' : ''} ${forceGo ? 'disabled' : ''}> 발권 후 바로 도착 챗으로 이동${forceGo ? ' <small>(메모리아 인계는 도착 챗에서 실행돼요)</small>' : ''}</label>
                </div>
            </div>
        </div>
        <div class="kts-tk-foot"><div class="sum"><b>#${t.start}–#${t.end} (${count}개)</b> → <b>${esc(t.destName)} · ${esc(cut(destLabel, 20))}</b>${bagNames.length ? ` · ${bagNames.join(' + ')}` : ''} · 원래 챗은 그대로 둬요</div>
            <button class="kts-b issue" data-act="tk-issue" ${valid ? '' : 'disabled'}>${t.busy ? '발권 중…' : '🎫 발권하기'}</button></div>
    </div>`;
}

// ---------------------------------------------------------------- interactions

function setRange(start, end) {
    const t = state.ticket;
    const max = Math.max(0, t.total - 1);
    start = Math.min(Math.max(0, Math.round(start)), max);
    end = Math.min(Math.max(0, Math.round(end)), max);
    if (start > end) [start, end] = [end, start];
    t.start = start;
    t.end = end;
}

export async function ticketClick(act, el) {
    const t = state.ticket;
    if (!t) return false;
    switch (act) {
        case 'ticket-close': closeTicket(); return true;
        case 'tk-quick': {
            const v = el.dataset.v;
            if (v === 'unsum') setRange(t.lastHidden + 1, t.total - 1);
            else if (v === 'all') setRange(0, t.total - 1);
            else setRange(t.total - Number(v), t.total - 1);
            app.render();
            return true;
        }
        case 'tk-mode': t.mode = el.dataset.v; t.destChat = null; app.render(); return true;
        case 'tk-bot': await loadDest(el.dataset.avatar); return true;
        case 'tk-destchat': t.destChat = el.dataset.id; app.render(); return true;
        case 'tk-bag': t.bag[el.dataset.v] = !t.bag[el.dataset.v]; app.render(); return true;
        case 'tk-issue': await issue(); return true;
    }
    return false;
}

export function ticketChange(ev) {
    const t = state.ticket;
    if (!t) return false;
    const id = ev.target.id;
    if (id === 'kts-tk-start' || id === 'kts-tk-end') {
        const s = id === 'kts-tk-start' ? Number(ev.target.value) : t.start;
        const e = id === 'kts-tk-end' ? Number(ev.target.value) : t.end;
        setRange(s, e);
        app.render();
        return true;
    }
    if (id === 'kts-tk-rename') { t.rename = ev.target.checked; return true; }
    if (id === 'kts-tk-go') { t.go = ev.target.checked; return true; }
    return false;
}

export function ticketInput(ev) {
    const t = state.ticket;
    if (!t || ev.target.id !== 'kts-tk-botq') return false;
    t.botQuery = ev.target.value;
    app.render();
    return true;
}

// Drag the 🚏/🚩 markers along the route.
export function ticketPointerDown(ev) {
    const t = state.ticket;
    const route = ev.target.closest('#kts-route');
    if (!t || !route || t.total < 2) return false;
    ev.preventDefault();
    const idxAt = (x) => {
        const r = document.getElementById('kts-route')?.getBoundingClientRect();
        if (!r || !r.width) return 0;
        return Math.round(Math.min(Math.max((x - r.left) / r.width, 0), 1) * (t.total - 1));
    };
    const first = idxAt(ev.clientX);
    const mk = ev.target.closest('[data-mk]')?.dataset.mk
        || (Math.abs(first - t.start) <= Math.abs(first - t.end) ? 'start' : 'end');
    const apply = (i) => {
        if (mk === 'start') setRange(Math.min(i, t.end), t.end);
        else setRange(t.start, Math.max(i, t.start));
        app.render();
    };
    apply(first);
    const move = (e) => apply(idxAt(e.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return true;
}

// ---------------------------------------------------------------- issue

// [[from, to], ...] like the elephant stores hidden messages
function toRanges(list) {
    const out = [];
    for (const i of [...list].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && i === last[1] + 1) last[1] = i; else out.push([i, i]);
    }
    return out;
}

function unhideAll(msgs) {
    for (const m of msgs) if (m.extra?.lm_hidden) { delete m.extra.lm_hidden; m.is_system = false; }
}

function prepareMessages(t) {
    const cross = t.destAvatar !== t.srcAvatar;
    // 🐘 messages the elephant already summarized (index <= its cursor) stay as they were in the source:
    // the carried memory already covers them, so they must not be summarized (and shown) a second time
    const cursor = t.bag.elephant ? Number(t.header?.chat_metadata?.long_memory?.cursor ?? -1) : -1;
    const out = t.msgs.slice(t.start, t.end + 1).map((orig, k) => {
        const m = structuredClone(orig);
        const covered = t.start + k <= cursor;
        const keepHidden = covered && !!orig.extra?.lm_hidden && !!orig.is_system;
        // un-hide the rest: the memory extensions in the new chat re-hide according to their own "keep N raw" settings
        if (isHidden(m) && !keepHidden) m.is_system = false;
        if (m.extra) {
            for (const k2 of ['branches', 'bookmark_link', 'lm_owner', 'lm_hidden', 'lm_turn', 'lm_check']) delete m.extra[k2];
            if (keepHidden) m.extra.lm_hidden = true;
        }
        // keep only the visible swipe
        delete m.swipes;
        delete m.swipe_id;
        delete m.swipe_info;
        if (cross && t.rename && !m.is_user && m.extra?.type !== 'narrator' && m.name === t.srcName) {
            m.name = t.destName;
            delete m.force_avatar;
        }
        return m;
    });
    if (t.bag.memo) {
        const e = entry(t.srcId, t.srcAvatar);
        out.unshift({
            name: 'System', is_user: false, is_system: false, send_date: nowStamp(),
            mes: `[지난 줄거리 · ${t.srcTitle}]\n${e.summary}`, force_avatar: 'img/five.png',
            extra: { type: 'narrator', api: 'manual', model: 'kkangtong-subway' },
        });
    }
    return out;
}

async function feedMemoria(t) {
    const input = document.getElementById('memoria_carry_input');
    if (!input) throw new Error('메모리아를 찾을 수 없어요');
    const store = t.header.chat_metadata.memoria;
    const payload = { type: 'memoria-export', version: store?.version ?? 1, exportedAt: new Date().toISOString(), chatId: t.srcId, store };
    const file = new File([JSON.stringify(payload)], 'kkangtong-transfer.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function issue() {
    const t = state.ticket;
    if (!t || t.busy) return;
    const c = ctx();
    const count = t.end - t.start + 1;
    const destTitle = t.mode === 'new' ? '새 노선' : title(t.destChat, t.destAvatar);
    const bagNames = [t.bag.memoria && '📚 메모리아', t.bag.elephant && '🐘 코끼리', t.bag.memo && '🗺️ 요약 메모'].filter(Boolean);
    const ok = await c.Popup.show.confirm('🎫 발권할까요?', `<div class="kts-pop-list">
        <p><b>${esc(t.srcName)} · ${esc(t.srcTitle)}</b>의 <b>#${t.start}–#${t.end} (${count}개)</b>를</p>
        <p>→ <b>${esc(t.destName)} · ${esc(destTitle)}</b>${t.mode === 'exist' ? ' 끝에 이어 붙여요' : '로 옮겨요'}</p>
        ${bagNames.length ? `<p>짐: ${bagNames.join(', ')}</p>` : ''}
        <p class="kts-muted">원래 챗은 건드리지 않아요.</p></div>`);
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;

    t.busy = true;
    app.render();
    try {
        const msgs = prepareMessages(t);
        const srcMeta = t.header?.chat_metadata || {};
        const elephantMem = t.bag.elephant ? elephantCarry(srcMeta.long_memory) : null;
        // how many of the moved messages the carried memory already covers (they come first in the range)
        const srcCursor = Number(srcMeta.long_memory?.cursor ?? -1);
        const covered = elephantMem ? Math.max(0, Math.min(t.end, srcCursor) - t.start + 1) : 0;
        const lead = msgs.length - (t.end - t.start + 1); // the 요약 메모 message, when added, sits in front
        // point the elephant's cursor at those messages, which now start at index `base` in the destination
        const coverFrom = (base) => {
            if (!elephantMem || !covered) return;
            elephantMem.cursor = base + lead + covered - 1;
            const hidden = [];
            msgs.forEach((m, i) => { if (m.is_system && m.extra?.lm_hidden) hidden.push(base + i); });
            elephantMem.hiddenRanges = toRanges(hidden);
        };
        const transfer = { avatar: t.srcAvatar, charName: t.srcName, id: t.srcId, title: t.srcTitle, range: [t.start, t.end], at: Date.now() };
        let destId;

        if (t.mode === 'new') {
            coverFrom(0);
            destId = `${t.destName} - ${c.humanizedDateTime()}`;
            const header = {
                user_name: c.name1,
                character_name: t.destName,
                create_date: c.humanizedDateTime(),
                chat_metadata: { integrity: crypto.randomUUID(), kkangtong_transfer: transfer, ...(elephantMem ? { long_memory: elephantMem } : {}) },
            };
            await ensureChatDir(t.destAvatar);
            await saveChatRaw(t.destAvatar, t.destName, destId, header, msgs);
            const se = entry(t.srcId, t.srcAvatar);
            setEntry(destId, {
                title: se.title ? `${se.title}` : undefined,
                summary: se.summary,
                transferFrom: transfer,
                status: 'run',
            }, t.destAvatar);
        } else {
            destId = t.destChat;
            const isOpen = openChar()?.avatar === t.destAvatar && c.getCurrentChatId() === destId;
            const destHeader = isOpen ? { chat_metadata: c.chatMetadata } : (await loadChatRaw(destId, t.destAvatar)).header;
            let putElephant = !!elephantMem;
            if (putElephant && elephantHasContent(destHeader?.chat_metadata?.long_memory)) {
                const r = await c.Popup.show.confirm('🐘 코끼리 기억', '도착 챗에 이미 코끼리 기억이 있어요. 출발 챗의 기억으로 <b>바꿀까요?</b><br><small>취소하면 도착 챗의 기억을 그대로 두고 메시지만 붙여요.</small>');
                putElephant = r === c.POPUP_RESULT.AFFIRMATIVE;
            }
            const base = isOpen ? c.chat.length : (await loadChatRaw(destId, t.destAvatar)).messages.length;
            // the destination's own earlier messages aren't in the carried memory, so only skip ahead when there are none
            if (putElephant && base === 0) coverFrom(0);
            else unhideAll(msgs);
            if (isOpen) {
                if (putElephant) c.chatMetadata.long_memory = elephantMem;
                c.chat.push(...msgs);
                await c.saveChat();
                await c.reloadCurrentChat();
            } else {
                const { header, messages } = await loadChatRaw(destId, t.destAvatar);
                if (putElephant) header.chat_metadata = { ...(header.chat_metadata || {}), long_memory: elephantMem };
                await saveChatRaw(t.destAvatar, t.destName, destId, header, [...messages, ...msgs]);
            }
        }

        const go = t.go || t.bag.memoria;
        const memoria = t.bag.memoria;
        const snapshot = { ...t };
        state.ticket = null;
        state.view = 'main';
        if (go) {
            app.closePopup();
            await openChatOf(snapshot.destAvatar, destId);
            if (memoria) {
                await wait(1500);
                try { await feedMemoria(snapshot); } catch (err) { console.error(LOG, err); toastr.warning(`메모리아 인계를 못 했어요: ${esc(errText(err))}`, TOAST, { escapeHtml: false }); }
            }
        } else {
            await app.refresh({ avatar: state.avatar, keepSelection: true });
        }
        toastr.success(`🎫 발권 완료! ${count}개 메시지가 「${esc(snapshot.destName)}」(으)로 환승했어요.`, TOAST, { escapeHtml: false });
    } catch (err) {
        console.error(LOG, 'ticket failed', err);
        toastr.error(`발권에 실패했어요: ${esc(errText(err))}`, TOAST, { escapeHtml: false });
        if (state.ticket) { state.ticket.busy = false; app.render(); }
    }
}
