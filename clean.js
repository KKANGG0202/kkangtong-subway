// 깡통 노선도 - "🧽 객차 청소": make heavy chats light again (and bring hidden messages back if wanted).
// Old swipes (the replies you didn't pick) and saved reasoning are often most of a chat file.
// Cleaning keeps the message you actually chose and drops the rest. Message text is never changed.

import { LOG, TOAST, state, app, ctx, esc, cut, fmtBytes, title, loadChatRaw, saveChatRaw, charByAvatar, openChar } from './core.js';
import { makeZip } from './download.js';

const enc = new TextEncoder();
const sizeOf = (header, messages) => enc.encode([header, ...messages].map((x) => JSON.stringify(x)).join('\n')).length;

/** What cleaning would do to one message list (pure: returns new objects, counts what goes). */
// hidden by /hide or by a memory extension (narrator/system notes are real system messages and stay as they are)
const isHidden = (m) => !!m?.is_system && !m?.extra?.type;

function cleaned(messages, { swipes = true, reasoning = false, unhide = false } = {}) {
    let swipeCount = 0;
    let reasonCount = 0;
    let hiddenCount = 0;
    const out = messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        const n = { ...m };
        if (swipes && Array.isArray(m.swipes) && m.swipes.length > 1) {
            const i = Number.isInteger(m.swipe_id) && m.swipe_id >= 0 && m.swipe_id < m.swipes.length ? m.swipe_id : 0;
            swipeCount += m.swipes.length - 1;
            n.swipes = [m.swipes[i] ?? m.mes];
            if (Array.isArray(m.swipe_info)) n.swipe_info = m.swipe_info[i] !== undefined ? [m.swipe_info[i]] : [];
            n.swipe_id = 0;
        }
        if (isHidden(m)) {
            hiddenCount++;
            if (unhide) { n.is_system = false; if (n.extra?.lm_hidden) { n.extra = { ...n.extra }; delete n.extra.lm_hidden; } }
        }
        if (reasoning) {
            if (n.extra?.reasoning) { n.extra = { ...n.extra }; delete n.extra.reasoning; delete n.extra.reasoning_duration; reasonCount++; }
            if (Array.isArray(n.swipe_info)) {
                n.swipe_info = n.swipe_info.map((si) => {
                    if (!si?.extra?.reasoning) return si;
                    const extra = { ...si.extra };
                    delete extra.reasoning;
                    delete extra.reasoning_duration;
                    return { ...si, extra };
                });
            }
        }
        return n;
    });
    return { out, swipeCount, reasonCount, hiddenCount };
}

const opts = () => state.wash.opts;

function headerFor(header, o) {
    if (!o.unhide || !header?.chat_metadata?.long_memory) return header;
    return { ...header, chat_metadata: { ...header.chat_metadata, long_memory: { ...header.chat_metadata.long_memory, hiddenRanges: [] } } };
}

// ---------------------------------------------------------------- analysis

export async function openWash(ids) {
    const avatar = state.avatar;
    if (!avatar) return;
    const list = (ids?.length ? ids : state.list.map((c) => c.id)).filter((id) => state.byId.has(id));
    state.view = 'wash';
    state.wash = { avatar, ids: list, rows: new Map(), pick: new Set(), done: 0, busy: 'scan', opts: { swipes: true, reasoning: false, unhide: false, backup: true } };
    app.render();
    for (const id of list) {
        if (state.view !== 'wash' || state.wash?.avatar !== avatar) return;
        try {
            const { header, messages } = await loadChatRaw(id, avatar);
            const before = sizeOf(header, messages);
            const all = cleaned(messages, { swipes: true, reasoning: true });
            const sw = cleaned(messages, { swipes: true, reasoning: false });
            const rs = cleaned(messages, { swipes: false, reasoning: true });
            state.wash.rows.set(id, {
                before,
                swipes: sw.swipeCount,
                reasoning: rs.reasonCount,
                hidden: sw.hiddenCount,
                afterSwipes: sizeOf(header, sw.out),
                afterReasoning: sizeOf(header, rs.out),
                afterBoth: sizeOf(header, all.out),
            });
            if (sw.swipeCount || rs.reasonCount || sw.hiddenCount) state.wash.pick.add(id);
        } catch (err) {
            console.warn(LOG, 'wash scan failed', id, err);
            state.wash.rows.set(id, { error: true });
        }
        state.wash.done++;
        if (state.wash.done % 5 === 0 || state.wash.done === list.length) app.render();
    }
    state.wash.busy = null;
    app.render();
}

function afterOf(r) {
    const o = opts();
    if (o.swipes && o.reasoning) return r.afterBoth;
    if (o.swipes) return r.afterSwipes;
    if (o.reasoning) return r.afterReasoning;
    return r.before;
}

// ---------------------------------------------------------------- rendering

export function washHtml() {
    const w = state.wash;
    if (!w) return '';
    const o = w.opts;
    const bot = charByAvatar(w.avatar)?.char?.name || '';
    let total = 0;
    let saved = 0;
    let swipes = 0;
    let hidden = 0;
    for (const id of w.pick) {
        const r = w.rows.get(id);
        if (!r || r.error) continue;
        total += r.before;
        saved += r.before - afterOf(r);
        if (o.swipes) swipes += r.swipes;
        if (o.unhide) hidden += r.hidden || 0;
    }
    const allBefore = [...w.rows.values()].reduce((n, r) => n + (r.before || 0), 0);
    const sorted = [...w.ids].sort((a, b) => (w.rows.get(b)?.before || 0) - (w.rows.get(a)?.before || 0));
    const rows = sorted.map((id) => {
        const r = w.rows.get(id);
        const on = w.pick.has(id);
        if (!r) return `<div class="kts-cl-row off"><span class="kts-ck"></span><span class="t">${esc(cut(title(id, w.avatar), 40))}</span><span class="m">분석 중…</span></div>`;
        if (r.error) return `<div class="kts-cl-row off"><span class="kts-ck"></span><span class="t">${esc(cut(title(id, w.avatar), 40))}</span><span class="m">못 읽었어요</span></div>`;
        const gain = r.before - afterOf(r);
        const bar = r.before ? Math.round((afterOf(r) / r.before) * 100) : 100;
        return `<div class="kts-cl-row wash ${on ? '' : 'off'}" data-act="wash-pick" data-id="${esc(id)}">
            <span class="kts-ck ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
            <span class="t">${esc(cut(title(id, w.avatar), 40))}<small>🔁 스와이프 ${r.swipes.toLocaleString()}개${r.reasoning ? ` · 🧠 추론 ${r.reasoning}개` : ''}${r.hidden ? ` · 🙈 숨김 ${r.hidden}개` : ''}</small></span>
            <span class="kts-wash-bar" title="청소 후 크기"><i style="width:${bar}%"></i></span>
            <span class="m">${fmtBytes(r.before)} → <b>${fmtBytes(afterOf(r))}</b>${gain > 0 ? ` <em>−${fmtBytes(gain)}</em>` : ''}</span>
        </div>`;
    }).join('');
    const chip = (k, label, hint) => `<label class="kts-wash-opt" title="${esc(hint)}"><input type="checkbox" id="kts-wash-${k}" ${o[k] ? 'checked' : ''}> ${label}</label>`;
    const scanning = w.busy === 'scan' ? ` · 분석 중 ${w.done}/${w.ids.length}` : '';
    const running = w.busy === 'run' ? `🧽 청소 중 ${w.done}/${w.total}` : '';
    return `<div class="kts-toolbar"><button class="kts-pill" data-act="wash-close">← 돌아가기</button><span class="kts-cur">🧽 객차 청소<small>${esc(cut(bot, 14))} · 역 ${w.ids.length}개 · 전부 ${fmtBytes(allBefore)}${scanning}</small></span></div>
    <div class="kts-wash-opts">
        ${chip('swipes', '🔁 스와이프 정리', '고르지 않은 스와이프(다시 생성한 답들)를 지우고, 지금 보이는 답만 남겨요')}
        ${chip('reasoning', '🧠 추론 기록 지우기', '모델이 남긴 생각(reasoning) 기록을 지워요. 답장 본문은 그대로예요')}
        ${chip('unhide', '👁️ 숨긴 메시지 모두 보이기', '/hide나 기억 확장이 숨긴 메시지를 전부 다시 보이게 해요. 코끼리의 숨김 기록도 같이 비워요')}
        ${chip('backup', '💾 청소 전에 원본 zip 받기', '고른 역들의 원본 .jsonl을 zip으로 먼저 받아둬요')}
        <button class="kts-pill" data-act="wash-all">${w.pick.size === w.ids.length ? '전부 해제' : '전부 고르기'}</button>
    </div>
    <div class="tw-hint">메시지 내용은 그대로 두고, <b>지금 보이는 답</b>만 남기고 나머지 스와이프를 지워요. 챗이 가벼워져서 여는 속도가 빨라져요. 지운 스와이프는 되돌릴 수 없어요.</div>
    <div class="kts-clean">${rows || '<div class="kts-empty">역이 없어요.</div>'}</div>
    <div class="kts-foot"><span>${running || `역 ${w.pick.size}개 고름 · ${o.swipes ? `스와이프 ${swipes.toLocaleString()}개 · ` : ''}${o.unhide && hidden ? `숨김 ${hidden.toLocaleString()}개 보이기 · ` : ''}약 <b>${fmtBytes(saved)}</b> 줄어요 (${fmtBytes(total)} → ${fmtBytes(total - saved)})`}</span>
        <button class="kts-b d" data-act="wash-run" ${w.busy || !w.pick.size || (!saved && !hidden) ? 'disabled' : ''}>🧽 ${w.pick.size}개 역 청소</button></div>`;
}

// ---------------------------------------------------------------- cleaning

async function runWash() {
    const w = state.wash;
    const o = w.opts;
    const ids = [...w.pick].filter((id) => { const r = w.rows.get(id); return r && !r.error && (r.before > afterOf(r) || (o.unhide && r.hidden)); });
    if (!ids.length) return;
    const c = ctx();
    const ok = await c.Popup.show.confirm('🧽 객차 청소', `<div class="kts-pop-list"><p>역 <b>${ids.length}개</b>를 청소해요.</p><ul>${o.swipes ? '<li>🔁 고르지 않은 스와이프를 지우고 지금 보이는 답만 남겨요</li>' : ''}${o.reasoning ? '<li>🧠 추론 기록을 지워요</li>' : ''}${o.unhide ? '<li>👁️ 숨긴 메시지를 전부 다시 보이게 해요. 기억 확장이 요약하고 숨긴 메시지라면 요약과 원문이 같이 들어가서 토큰이 늘 수 있어요</li>' : ''}</ul><p>${o.backup ? '먼저 원본을 zip으로 받아둘게요.' : '<b>원본 백업 없이</b> 진행해요. 되돌릴 수 없어요.'}</p></div>`);
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;
    w.busy = 'run';
    w.done = 0;
    w.total = ids.length;
    app.render();
    const charName = charByAvatar(w.avatar)?.char?.name || '';
    const openId = openChar()?.avatar === w.avatar ? c.getCurrentChatId() : null;
    let fail = 0;
    let saved = 0;
    try {
        if (o.backup) {
            const files = [];
            for (const id of ids) {
                const { header, messages } = await loadChatRaw(id, w.avatar);
                files.push({ name: `${id.replace(/[\\/:*?"<>|]+/g, '_')}.jsonl`, text: [header, ...messages].map((x) => JSON.stringify(x)).join('\n') });
            }
            const blob = makeZip(files);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${charName.replace(/[\\/:*?"<>|]+/g, '_') || 'bot'}_청소전_원본_${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
        }
        for (const id of ids) {
            try {
                if (id === openId) {
                    // the open chat lives in memory too: clean that copy and let ST save it, or ST would write the old one back
                    const res = cleaned(c.chat, o);
                    c.chat.splice(0, c.chat.length, ...res.out);
                    if (o.unhide && c.chatMetadata?.long_memory) c.chatMetadata.long_memory.hiddenRanges = [];
                    await c.saveChat();
                    await c.reloadCurrentChat?.();
                } else {
                    const { header, messages } = await loadChatRaw(id, w.avatar);
                    const res = cleaned(messages, o);
                    await saveChatRaw(w.avatar, charName, id, headerFor(header, o), res.out);
                }
                const r = w.rows.get(id);
                saved += r.before - afterOf(r);
            } catch (err) {
                console.error(LOG, 'wash failed', id, err);
                fail++;
            }
            w.done++;
            app.render();
        }
        toastr.success(`역 ${ids.length - fail}개를 청소했어요. 약 ${fmtBytes(saved)} 줄었어요.${fail ? ` (${fail}개 실패)` : ''}`, TOAST);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('청소하다가 문제가 생겼어요.', TOAST);
    }
    w.busy = null;
    state.mapStale = true;
    await openWash(w.ids);
}

// ---------------------------------------------------------------- events

export async function washClick(act, el) {
    const w = state.wash;
    switch (act) {
        case 'wash-open': await openWash(state.selectMode && state.checked.size ? [...state.checked] : null); return true;
        case 'wash-close': state.view = 'main'; state.wash = null; await app.refresh(); return true;
        case 'wash-pick': if (w && !w.busy) { const id = el.dataset.id; if (w.pick.has(id)) w.pick.delete(id); else w.pick.add(id); app.render(); } return true;
        case 'wash-all': if (w) { w.pick = w.pick.size === w.ids.length ? new Set() : new Set(w.ids); app.render(); } return true;
        case 'wash-run': if (w && !w.busy) await runWash(); return true;
    }
    return false;
}

export function washChange(ev) {
    const m = /^kts-wash-(swipes|reasoning|unhide|backup)$/.exec(ev.target.id || '');
    if (!m || !state.wash) return false;
    state.wash.opts[m[1]] = ev.target.checked;
    app.render();
    return true;
}

// ---------------------------------------------------------------- 🙈 hide / show a range of messages

export async function hideRange(id, avatar = state.avatar, { show = false } = {}) {
    const c = ctx();
    const isOpen = openChar()?.avatar === avatar && c.getCurrentChatId() === id;
    const { header, messages } = isOpen ? { header: null, messages: c.chat } : await loadChatRaw(id, avatar);
    const last = messages.length - 1;
    if (last < 0) return;
    const hiddenNow = messages.filter(isHidden).length;
    const keep = Math.min(20, last);
    const html = show
        ? `<div class="kts-pop-list"><p>👁️ <b>${esc(cut(title(id, avatar), 30))}</b>에서 다시 보이게 할 메시지 범위를 정해요.</p>
        <p><small>메시지는 #0 ~ #${last}번까지 있어요 · 지금 숨겨진 메시지 ${hiddenNow}개<br>기본값은 전부(#0 ~ #${last})예요.</small></p></div>`
        : `<div class="kts-pop-list"><p>🙈 <b>${esc(cut(title(id, avatar), 30))}</b>에서 숨길 메시지 범위를 정해요.</p>
        <p><small>메시지는 #0 ~ #${last}번까지 있어요 · 지금 숨겨진 메시지 ${hiddenNow}개<br>숨긴 메시지는 채팅에는 남아 있지만 AI에게는 보내지 않아요. 기본값은 최근 ${keep}개만 남기고 그 앞을 숨겨요.</small></p></div>`;
    const popup = new c.Popup(html, c.POPUP_TYPE.CONFIRM, '', {
        okButton: show ? '보이기' : '숨기기',
        cancelButton: '취소',
        customInputs: [
            { id: 'kts_h_from', label: '시작 번호 (#)', type: 'number', defaultState: '0', min: 0, max: last },
            { id: 'kts_h_to', label: '끝 번호 (#)', type: 'number', defaultState: String(show ? last : Math.max(0, last - keep)), min: 0, max: last },
        ],
    });
    const result = await popup.show();
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    let a = parseInt(popup.inputResults?.get('kts_h_from'), 10);
    let b = parseInt(popup.inputResults?.get('kts_h_to'), 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { toastr.warning('번호를 숫자로 적어주세요.', TOAST); return; }
    a = Math.max(0, Math.min(last, a));
    b = Math.max(0, Math.min(last, b));
    if (a > b) [a, b] = [b, a];
    try {
        if (isOpen && c.executeSlashCommandsWithOptions) {
            // the open chat: let ST do it, so the screen and the prompt update at once
            await c.executeSlashCommandsWithOptions(`/${show ? 'unhide' : 'hide'} ${a}-${b}`);
        } else {
            let n = 0;
            const out = messages.map((m, i) => {
                if (i < a || i > b || !m) return m;
                if (show && isHidden(m)) { n++; const x = { ...m, is_system: false }; if (x.extra?.lm_hidden) { x.extra = { ...x.extra }; delete x.extra.lm_hidden; } return x; }
                if (!show && !m.is_system) { n++; return { ...m, is_system: true }; }
                return m;
            });
            await saveChatRaw(avatar, charByAvatar(avatar)?.char?.name || '', id, header, out);
            if (!n) { toastr.info('바뀐 메시지가 없어요.', TOAST); return; }
        }
        toastr.success(`#${a} ~ #${b} 메시지를 ${show ? '다시 보이게 했어요' : '숨겼어요'}.`, TOAST);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('숨기기를 적용하지 못했어요.', TOAST);
    }
}
