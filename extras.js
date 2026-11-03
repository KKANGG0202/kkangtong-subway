// 깡통 노선도 - divergence point, branch compare, cleanup suggestions, poster, branch naming, announcements

import {
    STATUS, TOAST, LOG, state, app, ctx, getSettings, entry, setEntry, esc, cut, plain, fmtShort, fmtAgo, parseDate,
    title, fallbackTitle, hasTitle, loadChat, callModel, parseJsonReply, errText, currentChatId, openChar,
    summarizeChat, isRoot, resolveTheme, shownText, statusOf,
} from './core.js';

// ================================================================ divergence point

const sameMsg = (a, b) => a && b && a.mes === b.mes && !!a.is_user === !!b.is_user;

async function computeDivergence(avatar, branchId, parentId) {
    const [branch, parent] = await Promise.all([loadChat(branchId, avatar), loadChat(parentId, avatar)]);
    // ST marks the parent message it branched from with extra.branches
    let point = parent.findIndex((m) => Array.isArray(m?.extra?.branches) && m.extra.branches.includes(branchId));
    if (point < 0 || point >= branch.length) {
        let k = 0;
        const n = Math.min(branch.length, parent.length);
        while (k < n && sameMsg(branch[k], parent[k])) k++;
        point = k - 1;
    }
    // the marked message may be followed by messages that are still identical (e.g. the same reply kept in both)
    while (point >= -1 && sameMsg(branch[point + 1], parent[point + 1])) point++;
    if (point < 0) return { point: -1 };
    return {
        point,
        shared: parent[point],
        parentNext: parent[point + 1] || null,
        branchNext: branch[point + 1] || null,
        parentMore: Math.max(0, parent.length - point - 1),
        branchMore: Math.max(0, branch.length - point - 1),
    };
}

export function ensureDivergence(id, parentId) {
    const key = `${state.avatar}|${id}`;
    if (state.divergence.has(key)) return;
    state.divergence.set(key, 'loading');
    const avatar = state.avatar;
    computeDivergence(avatar, id, parentId)
        .then((r) => { state.divergence.set(key, r); app.render(); })
        .catch((err) => { console.warn(LOG, 'divergence failed', err); state.divergence.set(key, 'error'); app.render(); });
}

const pv = (m, n = 120) => m ? `<b>${esc(m.name || '')}</b> ${esc(cut(shownText(m), n))}` : '<span class="kts-muted">(메시지 없음)</span>';

// Two replies that start the same: show both from just before the first different character.
function forkPair(a, b, n = 90) {
    const ta = a ? shownText(a) : '';
    const tb = b ? shownText(b) : '';
    let p = 0;
    while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
    if (!a || !b || p < 30) return [pv(a, n), pv(b, n)];
    const from = Math.max(0, p - 20);
    const part = (m, t) => `<b>${esc(m.name || '')}</b> <span class="kts-muted">…</span>${esc(cut(t.slice(from), n))}`;
    return [part(a, ta), part(b, tb)];
}

export function divergenceHtml(id) {
    const r = state.divergence.get(`${state.avatar}|${id}`);
    if (!r || r === 'error') return '';
    if (r === 'loading') return '<div class="kts-div"><div class="h">📍 갈라진 지점 찾는 중…</div></div>';
    if (r.point < 0) return '<div class="kts-div"><div class="h">📍 처음부터 다른 내용이에요</div></div>';
    if (!r.parentNext && !r.branchNext) return '<div class="kts-div"><div class="h">📍 원본과 완전히 똑같아요 <small>갈라진 뒤로 아직 아무 메시지도 없어요</small></div></div>';
    const fork = forkPair(r.parentNext, r.branchNext);
    return `<div class="kts-div">
        <div class="h">📍 <b>#${r.point}</b>에서 갈라짐 <small>원본은 그 뒤로 ${r.parentMore}개 · 이 지선은 ${r.branchMore}개 진행</small></div>
        <div class="kts-div-shared"><small>#${r.point} 환승 지점</small>${pv(r.shared)}</div>
        <div class="kts-div-fork">
            <div><small>원본은 이렇게</small>${fork[0]}</div>
            <div class="me"><small>이 지선은 이렇게</small>${fork[1]}</div>
        </div>
    </div>`;
}

// ================================================================ compare two stations

export function compareHtml(id) {
    const cmp = state.compare;
    if (!cmp || cmp.source !== id) return '';
    const sibs = isRoot(id) ? [] : (state.children.get(state.byId.get(id).parent) || []);
    const others = [...new Set([...sibs, ...(state.children.get(id) || []), ...state.list.map((c) => c.id)])].filter((x) => x !== id);
    const opts = others.map((x) => `<option value="${esc(x)}" ${x === cmp.target ? 'selected' : ''}>${esc(cut(title(x), 40))}${sibs.includes(x) ? ' · 같은 지선' : ''}</option>`).join('');
    let body = '';
    if (cmp.busy) body = '<div class="kts-muted">🤖 두 노선을 비교하는 중이에요…</div>';
    else if (cmp.error) body = `<div class="warn">비교에 실패했어요: ${esc(cmp.error)}</div>`;
    else if (cmp.result) {
        const r = cmp.result;
        body = `<div class="kts-cmp-res">
            ${r.point >= 0 ? `<div class="kts-muted">#${r.point}까지는 같은 이야기예요</div>` : ''}
            ${r.shared ? `<p><b>공통</b> ${esc(r.shared)}</p>` : ''}
            <div class="kts-cmp-cols">
                <div><small>${esc(cut(title(id), 20))}</small>${esc(r.a || '')}</div>
                <div><small>${esc(cut(title(cmp.resultTarget), 20))}</small>${esc(r.b || '')}</div>
            </div>
            ${Array.isArray(r.differences) && r.differences.length ? `<ul>${r.differences.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        </div>`;
    }
    return `<div class="kts-cmp">
        <div class="h">⚖️ 다른 역과 비교 <a data-act="compare-close">닫기</a></div>
        <div class="row"><select id="kts-compare-target" class="kts-b">${opts}</select>
        <button class="kts-b p" data-act="compare-run" ${cmp.busy ? 'disabled' : ''}>🤖 비교하기</button></div>
        ${body}
    </div>`;
}

function tailText(msgs, from, budget = 9000) {
    const lines = [];
    for (let i = msgs.length - 1; i > from && budget > 0; i--) {
        const line = `${msgs[i].name || (msgs[i].is_user ? 'User' : 'Character')}: ${cut(plain(msgs[i].mes), 900)}`;
        budget -= line.length;
        if (budget < 0) break;
        lines.unshift(line);
    }
    return lines.join('\n\n') || '(no messages after the split)';
}

export async function runCompare() {
    const cmp = state.compare;
    if (!cmp?.target) return;
    const a = cmp.source;
    const b = cmp.target;
    cmp.busy = true;
    cmp.error = '';
    app.render();
    try {
        const [A, B] = await Promise.all([loadChat(a), loadChat(b)]);
        let k = 0;
        while (k < Math.min(A.length, B.length) && sameMsg(A[k], B[k])) k++;
        const point = k - 1;
        const lang = getSettings().outputLanguage || 'Korean';
        const sharedCtx = point >= 0 ? cut(plain(A[point].mes), 1200) : '(the two chats do not share a beginning)';
        const system = 'You compare two versions of a roleplay story that split from the same point. You only describe and compare; you never continue the story.';
        const user = `Two roleplay chats with the character "${state.charName}" share the same beginning and then diverge.

Last shared moment before they split:
${sharedCtx}

<chat_A title="${title(a)}">
${tailText(A, point)}
</chat_A>

<chat_B title="${title(b)}">
${tailText(B, point)}
</chat_B>

Compare where each version went after the split. Write in ${lang}.
Respond with JSON only:
{"shared": "one sentence about the common starting situation", "a": "2 sentences on what happens in A", "b": "2 sentences on what happens in B", "differences": ["3 short bullet points on the key differences (choices, relationships, outcomes)"]}`;
        const j = parseJsonReply(await callModel(system, user, 2000), ['a', 'b', 'shared', 'differences']);
        if (!j) throw new Error('응답을 읽지 못했어요');
        if (typeof j.differences === 'string') j.differences = [j.differences];
        cmp.result = { ...j, point };
        cmp.resultTarget = b;
    } catch (err) {
        console.error(LOG, 'compare failed', err);
        cmp.error = errText(err);
    }
    cmp.busy = false;
    app.render();
}

export function openCompare(id) {
    const sibs = isRoot(id) ? state.roots : (state.children.get(state.byId.get(id).parent) || []);
    const target = sibs.find((x) => x !== id) || (state.children.get(id) || [])[0] || state.list.find((c) => c.id !== id)?.id || null;
    state.compare = { source: id, target, busy: false, result: null };
    app.render();
}

// ================================================================ cleanup suggestions

export function cleanCfg() {
    const s = getSettings();
    return { shortMax: Number(s.cleanShortMax) || 4, staleDays: Number(s.cleanStaleDays) || 90, staleMax: Number(s.cleanStaleMax) || 20 };
}

export function recommendCandidates() {
    const cur = currentChatId();
    const now = Date.now();
    const cfg = cleanCfg();
    state.reasons.clear();
    let added = 0;
    for (const c of state.list) {
        if (c.id === cur) continue;
        const e = entry(c.id);
        if (e.pinned || e.status === 'run' || e.status === 'end') continue;
        const hasKids = (state.children.get(c.id) || []).length > 0;
        let reason = null;
        if (c.count <= 1) reason = '그리팅만';
        else if (statusOf(c.id).key === 'test') reason = '시험운행';
        else if (c.count <= cfg.shortMax && !hasKids) reason = `메시지 ${c.count}개`;
        else if (now - c.lastDate > cfg.staleDays * 86400e3 && c.count < cfg.staleMax && !hasKids) reason = `${cfg.staleDays}일 넘게 방치`;
        if (!reason) continue;
        state.reasons.set(c.id, reason);
        if (!state.checked.has(c.id)) { state.checked.add(c.id); added++; }
    }
    toastr.info(state.reasons.size
        ? `폐역 후보 ${state.reasons.size}개를 골랐어요. 지우기 전에 한 번 확인해 주세요. (⭐·🟢운행중·🏁종착은 제외)`
        : '추천할 폐역 후보가 없어요. 깔끔하네요!', TOAST);
    app.render();
}

// ================================================================ poster

function svgEsc(s) {
    return esc(s);
}

/** 🚇 horizontal view: save the rail exactly as it is drawn, with the colors of the current theme. */
export async function makeRailPoster(markup) {
    const tpl = document.createElement('template');
    tpl.innerHTML = markup || '';
    const svgEl = tpl.content.querySelector('svg.kts-rail') || document.querySelector('#kts-root .kts-rail');
    if (!svgEl) return false;
    const root = document.getElementById('kts-root');
    const css = getComputedStyle(root.querySelector('.kts-pop') || root);
    let inner = svgEl.innerHTML.replace(/var\((--kts-[a-z0-9-]+)\)/g, (m, v) => css.getPropertyValue(v).trim() || '#888');
    inner = inner.replace(/<rect\b[^>]*\brx="12"[^>]*\/?>(<\/rect>)?/g, ''); // drop the selection highlight
    const w = Number(svgEl.getAttribute('width'));
    const h = Number(svgEl.getAttribute('height'));
    const ink = css.getPropertyValue('--kts-ink').trim() || '#222';
    const sub = css.getPropertyValue('--kts-sub').trim() || '#888';
    const bg = css.getPropertyValue('--kts-bg').trim() || '#f7f3ec';
    const font = "Pretendard, 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";
    const top = 100;
    const W = Math.max(w + 40, 700);
    const H = h + top + 50;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <style>.nm{font:700 13px ${font};fill:${ink};paint-order:stroke;stroke:${bg};stroke-width:4px}.nm.none{fill:${sub};font-weight:500}.mt{font:10.5px ${font};fill:${sub};paint-order:stroke;stroke:${bg};stroke-width:3px}.dim{opacity:.3}</style>
        <rect width="${W}" height="${H}" fill="${bg}"/>
        <text x="40" y="54" font-family="${font}" font-size="28" font-weight="800" fill="${ink}">${esc(state.charName || '')} 노선도</text>
        <text x="40" y="80" font-family="${font}" font-size="14" fill="${sub}">역 ${state.list.length}개</text>
        <g transform="translate(20,${top})">${inner}</g>
        <text x="${W - 30}" y="${H - 18}" text-anchor="end" font-family="${font}" font-size="14" font-weight="700" fill="#e07a5f">🚇 깡통 노선도</text>
    </svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = W * scale;
        canvas.height = H * scale;
        const g = canvas.getContext('2d');
        g.scale(scale, scale);
        g.drawImage(img, 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${String(state.charName).replace(/[\\/:*?"<>|]+/g, '_')}_가로노선도.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toastr.success('가로 노선도를 저장했어요.', TOAST);
    } finally {
        URL.revokeObjectURL(url);
    }
    return true;
}

export async function makePoster({ rows, maxDepth }) {
    if (!rows.length) return;
    const W = 1240;
    const top = 190;
    const rowH = 60;
    const laneW = 34;
    const x0 = 70;
    const textX = x0 + (maxDepth + 1) * laneW + 6;
    const H = top + rows.length * rowH + 120;
    const ink = '#2d2a26';
    const rail = '#cfc8bb';
    const sub = '#8f877b';
    const font = "'Pretendard','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
    const lane = (d, anc) => (d === 0 ? rail : state.groupColor.get(anc[d - 1]) || rail);
    const X = (l) => x0 + l * laneW;
    const parts = [];
    rows.forEach((row, i) => {
        const y0 = top + i * rowH;
        const mid = y0 + rowH / 2;
        const sw = 6;
        for (let l = 0; l < row.depth; l++) {
            if (row.cont[l]) parts.push(`<line x1="${X(l)}" y1="${y0}" x2="${X(l)}" y2="${y0 + rowH}" stroke="${lane(l, row.ancestors)}" stroke-width="${sw}"/>`);
        }
        const own = lane(row.depth, row.ancestors);
        const d = row.depth;
        if (d === 0) { if (!row.first) parts.push(`<line x1="${X(0)}" y1="${y0}" x2="${X(0)}" y2="${mid}" stroke="${own}" stroke-width="${sw}"/>`); }
        else if (row.first) parts.push(`<path d="M${X(d - 1)} ${y0} C${X(d - 1)} ${y0 + rowH * 0.45} ${X(d)} ${y0 + rowH * 0.15} ${X(d)} ${mid}" fill="none" stroke="${own}" stroke-width="${sw}" stroke-linecap="round"/>`);
        else parts.push(`<line x1="${X(d)}" y1="${y0}" x2="${X(d)}" y2="${mid}" stroke="${own}" stroke-width="${sw}"/>`);
        if (row.hasKids && row.last) parts.push(`<line x1="${X(d)}" y1="${mid}" x2="${X(d)}" y2="${y0 + rowH}" stroke="${state.groupColor.get(row.id) || own}" stroke-width="${sw}"/>`);
        else if (!row.last) parts.push(`<line x1="${X(d)}" y1="${mid}" x2="${X(d)}" y2="${y0 + rowH}" stroke="${own}" stroke-width="${sw}"/>`);
        const xfer = (state.children.get(row.id) || []).length > 0;
        if (xfer) parts.push(`<circle cx="${X(d)}" cy="${mid}" r="12" fill="#fff" stroke="${ink}" stroke-width="3.5"/><circle cx="${X(d)}" cy="${mid}" r="4.5" fill="${ink}"/>`);
        else parts.push(`<circle cx="${X(d)}" cy="${mid}" r="8" fill="#fff" stroke="${own === rail ? '#a59d8f' : own}" stroke-width="4"/>`);
        const c = state.byId.get(row.id);
        const e = entry(row.id);
        const tx = textX + 0;
        const name = `${e.pinned ? '⭐ ' : ''}${cut(title(row.id), 30)}${statusOf(row.id).key ? ` ${STATUS[statusOf(row.id).key].icon}` : ''}`;
        parts.push(`<text x="${tx}" y="${mid - (e.summary ? 3 : -6)}" font-family="${font}" font-size="19" font-weight="${xfer || d === 0 ? 800 : 600}" fill="${hasTitle(row.id) ? ink : sub}">${svgEsc(name)}</text>`);
        if (e.summary) parts.push(`<text x="${tx}" y="${mid + 17}" font-family="${font}" font-size="12.5" fill="${sub}">${svgEsc(cut(e.summary, 62))}</text>`);
        parts.push(`<text x="${W - 60}" y="${mid + 5}" text-anchor="end" font-family="${font}" font-size="13" fill="${sub}">${c.count} · ${fmtShort(c.lastDate)}</text>`);
    });
    const branches = state.list.length - state.roots.length;
    const today = new Date();
    const legendY = top + rows.length * rowH + 50;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="${W}" height="${H}" fill="#faf8f3"/>
        <rect x="0" y="0" width="${W}" height="14" fill="#e07a5f"/>
        <circle cx="${x0}" cy="88" r="26" fill="none" stroke="#e07a5f" stroke-width="7"/>
        <text x="${x0}" y="96" text-anchor="middle" font-family="${font}" font-size="20" font-weight="900" fill="#e07a5f">깡</text>
        <text x="${x0 + 48}" y="86" font-family="${font}" font-size="38" font-weight="900" fill="${ink}">${svgEsc(cut(state.charName, 26))} 노선도</text>
        <text x="${x0 + 50}" y="120" font-family="${font}" font-size="15" fill="${sub}">역 ${state.list.length}개 · 지선 ${branches}개 · ${today.getFullYear()}.${today.getMonth() + 1}.${today.getDate()}</text>
        <line x1="${x0 - 20}" y1="${top - 22}" x2="${W - 50}" y2="${top - 22}" stroke="#e8e2d6" stroke-width="2"/>
        ${parts.join('\n')}
        <line x1="${x0 - 20}" y1="${legendY - 26}" x2="${W - 50}" y2="${legendY - 26}" stroke="#e8e2d6" stroke-width="2"/>
        <circle cx="${x0}" cy="${legendY}" r="8" fill="#fff" stroke="#a59d8f" stroke-width="4"/>
        <text x="${x0 + 18}" y="${legendY + 5}" font-family="${font}" font-size="14" fill="${sub}">역 (챗)</text>
        <circle cx="${x0 + 110}" cy="${legendY}" r="11" fill="#fff" stroke="${ink}" stroke-width="3.5"/><circle cx="${x0 + 110}" cy="${legendY}" r="4" fill="${ink}"/>
        <text x="${x0 + 130}" y="${legendY + 5}" font-family="${font}" font-size="14" fill="${sub}">환승역 (분기 있음)</text>
        <text x="${W - 60}" y="${legendY + 5}" text-anchor="end" font-family="${font}" font-size="14" font-weight="700" fill="#e07a5f">🚇 깡통 노선도</text>
    </svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = W * scale;
        canvas.height = H * scale;
        const g = canvas.getContext('2d');
        g.scale(scale, scale);
        g.drawImage(img, 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${String(state.charName).replace(/[\\/:*?"<>|]+/g, '_')}_노선도.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toastr.success('노선도 포스터를 저장했어요.', TOAST);
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ================================================================ branch naming + announcement

let lastChat = null;
const askedBranch = new Set();
let announceTimer = null;

export async function onChatChanged() {
    const c = ctx();
    const ch = openChar();
    const id = c.getCurrentChatId?.();
    const prev = lastChat;
    lastChat = ch && id ? { avatar: ch.avatar, id } : null;
    removeAnnounce();
    if (!ch || !id) return;
    const meta = c.chatMetadata || {};
    const parent = meta.main_chat ? String(meta.main_chat).replace(/\.jsonl$/, '') : null;
    const s = getSettings();
    // A brand-new branch: ST opens it right after creating it from the parent chat
    if (s.askBranchName && parent && prev && prev.avatar === ch.avatar && prev.id === parent
        && / - Branch #\d+$/.test(id) && !entry(id, ch.avatar).title && !askedBranch.has(id)) {
        askedBranch.add(id);
        try {
            const name = await c.Popup.show.input(
                '🚇 새 지선 개통',
                `<b>${esc(title(parent, ch.avatar))}</b>에서 갈라진 새 지선이에요.<br>이름을 붙여주세요. 비워두면 나중에 AI가 지어요.`,
                '',
            );
            if (typeof name === 'string' && name.trim()) {
                setEntry(id, { title: name.trim().slice(0, 60), titleLocked: true }, ch.avatar);
                toastr.success(`「${name.trim()}」 지선이 개통됐어요.`, TOAST);
            }
        } catch (err) { console.warn(LOG, err); }
        return;
    }
    try { showAnnounce(ch, id, parent); } catch (err) { console.warn(LOG, 'announce failed', err); }
}

function removeAnnounce() {
    clearTimeout(announceTimer);
    document.getElementById('kts-announce')?.remove();
}

function showAnnounce(ch, id, parent) {
    const s = getSettings();
    if (s.announce === 'off') return;
    const e = entry(id, ch.avatar);
    const chat = ctx().chat || [];
    if (chat.length < 2) return;
    const last = [...chat].reverse().find((m) => m && !m.is_system) || chat[chat.length - 1];
    const lastTs = parseDate(last?.send_date);
    if (s.announce === 'away' && lastTs && Date.now() - lastTs < (Number(s.announceDays) || 60) * 86400e3) return;
    const stale = e.summary && e.summarizedCount ? chat.length - e.summarizedCount : 0;
    const host = document.getElementById('sheld') || document.body;
    const el = document.createElement('div');
    el.id = 'kts-announce';
    el.dataset.theme = resolveTheme();
    const render = () => {
        const cur = entry(id, ch.avatar);
        el.innerHTML = `<div class="kts-an-board">
            <div class="kts-an-top"><span class="kts-an-ic">🚇</span><span>이번 역은</span><b>${esc(title(id, ch.avatar))}</b><span>역입니다</span>
                <button class="kts-an-x" data-an="close" title="닫기">✕</button></div>
            <div class="kts-an-meta">${lastTs ? `마지막 탑승 ${fmtAgo(lastTs)} · ` : ''}메시지 ${chat.length}개${stale >= 10 ? ` · 요약 후 ${stale}개 더 진행됨` : ''}</div>
            ${cur.summary ? `<div class="kts-an-sum"><small>지난 줄거리</small>${esc(cur.summary)}</div>` : '<div class="kts-an-sum none"><small>지난 줄거리</small>아직 요약이 없는 역이에요. 마지막 대화들을 읽고 어디까지 왔는지 정리해 드릴까요?</div>'}
            ${last?.mes ? `<div class="kts-an-last">“${esc(cut(shownText(last), 140))}”</div>` : ''}
            <div class="kts-an-btns">
                ${!cur.summary ? '<button data-an="refresh" class="p">🤖 지난 줄거리 불러오기</button>' : stale >= 10 ? '<button data-an="refresh">🤖 줄거리 갱신</button>' : ''}
                <button data-an="map">🗺️ 노선도</button>
                <button data-an="close" class="${cur.summary ? 'p' : ''}">탑승 완료</button>
            </div>
        </div>`;
    };
    render();
    el.addEventListener('mouseenter', () => clearTimeout(announceTimer));
    el.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-an]');
        if (!b) return;
        const act = b.dataset.an;
        if (act === 'close') removeAnnounce();
        if (act === 'map') { removeAnnounce(); app.openPopup(); }
        if (act === 'refresh') {
            clearTimeout(announceTimer); // stay on screen while the summary is being written
            b.disabled = true;
            b.textContent = '🤖 갱신 중…';
            try {
                await summarizeChat({ avatar: ch.avatar, charName: ch.name, id, parentId: parent, count: chat.length - 1 });
                render();
            } catch (err) {
                toastr.error(`줄거리 갱신 실패: ${esc(errText(err))}`, TOAST, { escapeHtml: false });
                b.disabled = false;
                b.textContent = '🤖 줄거리 갱신';
            }
        }
    });
    host.appendChild(el);
    announceTimer = setTimeout(removeAnnounce, 20000);
}

export { fallbackTitle };
