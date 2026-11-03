// 깡통 노선도 - "🕸️ 관계 노선도": the people of a bot's stories as stations, their relationships as lines.
// Built from what the memory extensions already wrote down (no API calls):
//   - 코끼리를 생각하지마: chat_metadata.long_memory.ledger.entries with cat 'relation', key "A -> B"
//   - Memoria:            chat_metadata.memoria.characters[].relationships [{ target, relation }]
// Every chat (station) of the bot is read, so the map can show how a relationship differs between branches.

import { LOG, TOAST, state, app, ctx, esc, cut, title, charByAvatar, getSettings, save, parseDate, callModel, errText } from './core.js';

const REL_SPLIT = /\s*(?:<->|<=>|↔|-->|->|=>|→|⇒|➔)\s*|\s+[-–—]\s+/;
const BOTH = /<->|<=>|↔|\s[-–—]\s/;
// relationship kinds: each one is drawn as its own "line color", like subway lines
const REL_TYPES = [
    ['love', '💕 연애', '#e0558f', /lover|romance|romantic|crush|fianc|spouse|wife|husband|boyfriend|girlfriend|beloved|married|marriage|betroth|soulmate|\bmate\b|possessive|obsess|devot|in love|연인|애인|약혼|짝사랑|썸|부부|남편|아내|배우자|사랑|결혼|첫사랑|집착|소유|정혼|혼약|약혼녀|약혼자/i],
    ['family', '👪 가족', '#3fae8f', /mother|father|mom|dad|parent|adopt|raising|raised|son\b|daughter|brother|sister|sibling|twin|cousin|uncle|aunt|niece|nephew|grand|family|godfather|godmother|godson|goddaughter|엄마|아빠|어머니|아버지|부모|양부|양모|입양|키우|기르|아들|딸|형|누나|언니|오빠|동생|남매|형제|자매|쌍둥이|사촌|삼촌|이모|고모|조카|할머니|할아버지|가족|대부|대모/i],
    ['enemy', '⚔️ 적대', '#d9483b', /enemy|rival|nemesis|murder|kill|hate|captor|tormentor|abuser|foe|hostile|threat|원수|^적$|숙적|라이벌|살해|증오|원한|대립|적대|위협|납치/i],
    ['mentor', '🎓 스승·보호', '#e9a23b', /mentor|teacher|student|ward|guide|anchor|caretaker|carer|raise|nurtur|look(s|ing)? after|watch(es|ing)? over|tutor|master|apprentice|pupil|guardian|protector|headmaster|professor|servant|lord|boss|subordinate|스승|제자|선생|학생|보호자|보호|후견|양육|돌보|돌봐|보살|지키|지켜|수호|길잡이|인도자|이끄|피보호|피후견|주인|하인|부하|상관|보스|교수|교장/i],
    ['friend', '🤝 우정·동료', '#3fa7d6', /friend|ally|comrade|partner|colleague|classmate|teammate|companion|confidant|best|친구|동료|동기|파트너|단짝|절친|조력|동맹|룸메|소꿉/i],
];
const OTHER = ['other', '··· 그 밖', '#9a8f80'];
// relation notes usually lead with the main tie ("adoptive father, fears she'll turn dark"):
// the kind whose word appears first wins
const TIE_ORDER = ['love', 'family', 'mentor', 'friend', 'enemy'];
// "future mortal enemy", "former lover", "미래의 적": not what they are now, so they don't decide the color
const NOT_NOW = /\b(future|former|eventual|one[- ]day|ex-|once|past|destined)\b[^,;/.]*|(미래의|장래의|훗날의|한때의?|전\s)[^,;/.]*/gi;

function typeOf(text) {
    const now = String(text).replace(NOT_NOW, ' ');
    if (now.trim().length >= 3 && now !== text) { const t = typeOfRaw(now); if (t !== OTHER) return t; }
    return typeOfRaw(text);
}

function typeOfRaw(text) {
    let best = OTHER;
    let at = Infinity;
    for (const t of REL_TYPES) {
        const m = t[3].exec(text);
        if (m && m.index < at) { at = m.index; best = t; }
    }
    return best;
}
const LIMITS = [10, 16, 26, 60];
// landscape on wide screens, portrait on phones (so names stay readable)
let W = 820;
let H = 600;

// 🇰🇷 Korean view: translations are made once (one request per batch) and kept, so reopening costs nothing
const koStore = () => { const s = getSettings(); if (!s.relKo || typeof s.relKo !== 'object') s.relKo = {}; return s.relKo; };
const tr = (t) => (state.rel?.ko && koStore()[t]) || t;

const keyOf = (name) => String(name || '').toLowerCase().normalize('NFKC').replace(/\s+/g, '');

// ---------------------------------------------------------------- reading the memory records

function fromElephant(meta) {
    const out = [];
    for (const e of meta?.long_memory?.ledger?.entries || []) {
        if (e?.cat !== 'relation') continue;
        const parts = String(e.key || '').split(REL_SPLIT).map((x) => x.trim()).filter(Boolean);
        if (parts.length < 2 || !String(e.value || '').trim()) continue;
        out.push({ a: parts[0], b: parts[1], text: String(e.value).trim(), both: BOTH.test(e.key), src: '🐘', closed: e.status === 'closed' });
    }
    return out;
}

function fromMemoria(meta) {
    const out = [];
    const roles = new Map();
    const akas = new Map(); // name -> other spellings Memoria knows for the same person
    for (const c of meta?.memoria?.characters || []) {
        if (!c?.name || c.disabled) continue;
        if (c.role) roles.set(keyOf(c.name), String(c.role));
        const aka = [...(c.aka || []), ...(c.aliases || [])].map(String).filter(Boolean);
        if (aka.length) akas.set(c.name, aka);
        for (const r of c.relationships || []) {
            if (!r?.target || !r?.relation) continue;
            out.push({ a: c.name, b: r.target, text: String(r.relation).trim(), both: false, src: '📚' });
        }
    }
    return { rels: out, roles, akas };
}

async function chatsWithMeta(avatar) {
    const res = await fetch('/api/characters/chats', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, metadata: true }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function openRel(avatar = state.avatar) {
    if (!avatar) return;
    state.view = 'rel';
    state.rel = { avatar, loading: true, scope: 'all', focus: null, ko: !!getSettings().relKoOn };
    app.render();
    try {
        const raw = await chatsWithMeta(avatar);
        const chats = [];
        for (const x of raw) {
            const id = String(x.file_id ?? String(x.file_name).replace(/\.jsonl$/, ''));
            const meta = x.chat_metadata || {};
            const m = fromMemoria(meta);
            const rels = [...fromElephant(meta), ...m.rels];
            if (rels.length) chats.push({ id, rels, roles: m.roles, akas: m.akas, last: parseDate(x.last_mes, id) });
        }
        // a chat that was just opened may have newer records in memory than on disk
        const open = ctx();
        if (open.getCurrentChatId?.() && !open.groupId && open.characters?.[open.characterId]?.avatar === avatar) {
            const id = open.getCurrentChatId();
            const m = fromMemoria(open.chatMetadata);
            const rels = [...fromElephant(open.chatMetadata), ...m.rels];
            const i = chats.findIndex((c) => c.id === id);
            if (rels.length) { const last = Date.now(); const c2 = { id, rels, roles: m.roles, akas: m.akas, last }; if (i >= 0) chats[i] = c2; else chats.push(c2); }
        }
        state.rel.chats = chats;
    } catch (err) {
        console.error(LOG, err);
        state.rel.error = '챗 기록을 읽지 못했어요.';
    }
    state.rel.loading = false;
    app.render();
}

// ---------------------------------------------------------------- building the graph

// pair kinds you set by hand, per bot: { "a|b": "love" }
function pairStore() {
    const s = getSettings();
    if (!s.relPairs || typeof s.relPairs !== 'object') s.relPairs = {};
    const av = state.rel?.avatar || '_';
    if (!s.relPairs[av]) s.relPairs[av] = {};
    return s.relPairs[av];
}

// names you merged by hand, per bot: { fromKey: toKey } (a key mapped to itself = "keep apart")
function aliasStore() {
    const s = getSettings();
    if (!s.relAlias || typeof s.relAlias !== 'object') s.relAlias = {};
    const av = state.rel?.avatar || '_';
    if (!s.relAlias[av]) s.relAlias[av] = {};
    return s.relAlias[av];
}

/**
 * One person often appears under several names ("Harry" and "Harry Potter", Memoria's aka list).
 * Returns key -> canonical key, plus the best display name for each canonical key.
 */
function aliasResolver(chats) {
    const display = new Map();
    const see = (name) => {
        const k = keyOf(name);
        const t = String(name).trim();
        if (k && (!display.has(k) || t.length > display.get(k).length)) display.set(k, t);
    };
    for (const c of chats) {
        for (const r of c.rels) { see(r.a); see(r.b); }
        for (const [name, list] of c.akas || []) { see(name); list.forEach(see); }
    }
    const map = new Map();
    for (const c of chats) for (const [name, list] of c.akas || []) for (const a of list) if (keyOf(a) !== keyOf(name)) map.set(keyOf(a), keyOf(name));
    // a one-word name joins the only longer name that starts with it ("Thea" -> "Thea Riddle"),
    // but only for given name + family name: "하윤 엄마", "Thea's mother", "Harry Jr." are different people
    const KIN = /^(mom|mum|mother|dad|father|sister|brother|son|daughter|wife|husband|jr\.?|sr\.?|ii|iii|'s|엄마|아빠|어머니|아버지|언니|오빠|누나|형|동생|아들|딸|씨|님|선배|후배|부인|남편|할머니|할아버지)$/i;
    const fullName = (words) => words.length === 2 && /^[A-Z][\p{L}'-]+$/u.test(words[1]) && !KIN.test(words[1]) && !/'s$/i.test(words[0]);
    const byFirst = new Map();
    for (const [k, t] of display) {
        const words = t.split(/\s+/);
        if (words.length < 2 || !fullName(words)) continue;
        const f = keyOf(words[0]);
        if (!byFirst.has(f)) byFirst.set(f, new Set());
        byFirst.get(f).add(k);
    }
    for (const [k, t] of display) {
        if (t.split(/\s+/).length > 1 || map.has(k)) continue;
        const cand = byFirst.get(k);
        if (cand?.size === 1) map.set(k, [...cand][0]);
    }
    const manual = aliasStore();
    for (const [f, t] of Object.entries(manual)) { if (f === t) map.delete(f); else map.set(f, t); }
    const resolve = (k) => {
        let cur = k;
        for (let i = 0; i < 6 && map.has(cur) && map.get(cur) !== cur; i++) cur = map.get(cur);
        return cur;
    };
    return { resolve, display, map };
}

function buildGraph(chats, { limit = 16, off = new Set() } = {}) {
    const nodes = new Map(); // key -> { key, name, role, deg, chats:Set }
    const edges = new Map(); // "ka|kb" sorted -> { a, b, items: [{ from, to, text, chat, src }] }
    const { resolve, display, map } = aliasResolver(chats);
    const node = (name, chat) => {
        const k = resolve(keyOf(name));
        if (!nodes.has(k)) nodes.set(k, { key: k, name: display.get(k) || String(name).trim(), role: '', deg: 0, chats: new Set(), also: new Set() });
        if (keyOf(name) !== k) nodes.get(k).also.add(String(name).trim());
        nodes.get(k).chats.add(chat);
        return nodes.get(k);
    };
    for (const c of chats) {
        for (const [k0, role] of c.roles) { const k = resolve(k0); if (nodes.has(k) && !nodes.get(k).role) nodes.get(k).role = role; }
        for (const r of c.rels) {
            const A = node(r.a, c.id);
            const B = node(r.b, c.id);
            if (A === B) continue;
            const [x, y] = A.key < B.key ? [A, B] : [B, A];
            const ek = `${x.key}|${y.key}`;
            if (!edges.has(ek)) edges.set(ek, { a: x.key, b: y.key, items: [] });
            const e = edges.get(ek);
            const dup = e.items.find((it) => it.from === A.key && it.to === B.key && it.chat === c.id && it.text === r.text);
            if (!dup) e.items.push({ from: A.key, to: B.key, text: r.text, chat: c.id, src: r.src, both: r.both });
        }
        for (const [k0, role] of c.roles) { const k = resolve(k0); if (nodes.has(k) && !nodes.get(k).role) nodes.get(k).role = role; }
    }
    // the kind of each pair: the one you picked > how the most recently ridden chat describes it > the most common
    const fixed = pairStore();
    const lastOf = new Map(chats.map((c) => [c.id, c.last || 0]));
    for (const e of edges.values()) {
        const pick = fixed[`${e.a}|${e.b}`];
        const chosen = pick && [...REL_TYPES, OTHER].find((t) => t[0] === pick);
        if (chosen) { e.type = chosen; e.fixed = true; continue; }
        const newest = Math.max(...e.items.map((it) => lastOf.get(it.chat) || 0));
        const recent = e.items.filter((it) => (lastOf.get(it.chat) || 0) === newest);
        const count = new Map();
        for (const it of recent) { const t = typeOf(it.text); if (t !== OTHER) count.set(t, (count.get(t) || 0) + 1); }
        if (!count.size) for (const it of e.items) { const t = typeOf(it.text); if (t !== OTHER) count.set(t, (count.get(t) || 0) + 1); }
        e.type = count.size ? [...count].sort((x, y) => y[1] - x[1] || TIE_ORDER.indexOf(x[0][0]) - TIE_ORDER.indexOf(y[0][0]))[0][0] : OTHER;
    }
    const typed = [...edges.values()].filter((e) => !off.has(e.type[0]));
    for (const n of nodes.values()) n.deg = 0;
    for (const e of typed) { nodes.get(e.a).deg++; nodes.get(e.b).deg++; }
    // keep the busiest characters so the map stays readable
    const keep = new Set([...nodes.values()].filter((n) => n.deg > 0).sort((p, q) => q.deg - p.deg).slice(0, limit).map((n) => n.key));
    const N = [...nodes.values()].filter((n) => keep.has(n.key));
    const E = typed.filter((e) => keep.has(e.a) && keep.has(e.b));
    return { nodes: N, edges: E, hidden: [...nodes.values()].filter((n) => n.deg > 0).length - N.length, typesUsed: new Set([...edges.values()].map((e) => e.type)) };
}

// Fruchterman–Reingold layout (deterministic start): fills the whole map, the busiest character ends up central.
function layout(nodes, edges) {
    const pos = new Map();
    const n = nodes.length;
    const sorted = [...nodes].sort((x, y) => y.deg - x.deg);
    const PAD = 70;
    const area = (W - PAD * 2) * (H - PAD * 2);
    const k0 = Math.sqrt(area / Math.max(1, n)) * 1.5;
    sorted.forEach((v, i) => {
        const ang = i * 2.399963; // golden angle spiral: even spread, no randomness
        const rr = Math.sqrt((i + 0.5) / n);
        pos.set(v.key, { x: W / 2 + Math.cos(ang) * rr * (W / 2 - PAD), y: H / 2 + Math.sin(ang) * rr * (H / 2 - PAD) });
    });
    const links = edges.map((e) => [e.a, e.b]);
    let temp = W / 8;
    for (let it = 0; it < 300; it++) {
        const f = new Map(nodes.map((v) => [v.key, { x: 0, y: 0 }]));
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const A = pos.get(nodes[i].key); const B = pos.get(nodes[j].key);
            const dx = A.x - B.x; const dy = A.y - B.y;
            const d = Math.max(8, Math.hypot(dx, dy));
            const rep = (k0 * k0) / d;
            f.get(nodes[i].key).x += dx / d * rep; f.get(nodes[i].key).y += dy / d * rep;
            f.get(nodes[j].key).x -= dx / d * rep; f.get(nodes[j].key).y -= dy / d * rep;
        }
        for (const [p, q] of links) {
            const A = pos.get(p); const B = pos.get(q);
            const dx = A.x - B.x; const dy = A.y - B.y;
            const d = Math.max(8, Math.hypot(dx, dy));
            const att = (d * d) / k0;
            f.get(p).x -= dx / d * att; f.get(p).y -= dy / d * att;
            f.get(q).x += dx / d * att; f.get(q).y += dy / d * att;
        }
        // gentle pull to the middle so loose characters don't drift to the edges
        for (const v of nodes) { const P = pos.get(v.key); f.get(v.key).x += (W / 2 - P.x) * 0.004 * k0 / 40; f.get(v.key).y += (H / 2 - P.y) * 0.004 * k0 / 40; }
        for (const v of nodes) {
            const P = pos.get(v.key); const F = f.get(v.key);
            const m = Math.max(1e-6, Math.hypot(F.x, F.y));
            P.x += F.x / m * Math.min(m, temp);
            P.y += F.y / m * Math.min(m, temp);
            P.x = Math.max(PAD, Math.min(W - PAD, P.x));
            P.y = Math.max(PAD - 20, Math.min(H - PAD, P.y));
        }
        temp = Math.max(1, temp * 0.985);
    }
    // finally push apart stations whose names would overlap (names are wider than they are tall)
    for (let it = 0; it < 80; it++) {
        let moved = false;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const a = pos.get(nodes[i].key); const b = pos.get(nodes[j].key);
            const dx = b.x - a.x; const dy = b.y - a.y;
            const needX = 118; const needY = 58;
            if (Math.abs(dx) < needX && Math.abs(dy) < needY) {
                const px = (needX - Math.abs(dx)) / 2; const py = (needY - Math.abs(dy)) / 2;
                if (px < py) { const sx = (dx >= 0 ? 1 : -1) * px; a.x -= sx; b.x += sx; } else { const sy = (dy >= 0 ? 1 : -1) * py; a.y -= sy; b.y += sy; }
                moved = true;
            }
        }
        for (const v of nodes) { const p = pos.get(v.key); p.x = Math.max(60, Math.min(W - 60, p.x)); p.y = Math.max(40, Math.min(H - 50, p.y)); }
        if (!moved) break;
    }
    return pos;
}

// is the memory extension switched on right now? (an old record of one you turned off shouldn't decide the map)
function extOn(which) {
    const es = ctx().extensionSettings || {};
    const disabled = (es.disabledExtensions || []).map(String);
    if (which === '📚') return !!document.getElementById('memoria_carry_input') && es.memoria?.enabled !== false && !disabled.some((x) => /memoria/i.test(x));
    return typeof globalThis.longMemoryInterceptor === 'function' && es.long_memory?.enabled !== false && !disabled.some((x) => /elephant/i.test(x));
}

function sources() {
    const r = state.rel;
    if (!r.src) {
        const saved = getSettings().relSources;
        if (Array.isArray(saved)) r.src = new Set(saved);
        else {
            r.src = new Set(['🐘', '📚'].filter(extOn));
            if (!r.src.size) r.src = new Set(['🐘', '📚']);
        }
    }
    return r.src;
}

function scopedChats() {
    const r = state.rel;
    const src = sources();
    const list = r.scope === 'all' ? r.chats : r.chats.filter((c) => c.id === r.scope);
    return list.map((c) => ({
        ...c,
        rels: c.rels.filter((x) => src.has(x.src)),
        roles: src.has('📚') ? c.roles : new Map(),
        akas: src.has('📚') ? c.akas : new Map(),
    })).filter((c) => c.rels.length);
}

/** A pair whose relationship is written differently in different chats (branches). */
// the line is drawn dashed only while the pair isn't settled by you; the list below always shows the differences
function differs(e) {
    return !e.fixed && textDiffers(e);
}

function textDiffers(e) {
    const byChat = new Map();
    for (const it of e.items) {
        if (!byChat.has(it.chat)) byChat.set(it.chat, new Set());
        byChat.get(it.chat).add(it.text);
    }
    if (byChat.size < 2) return false;
    const sigs = new Set([...byChat.values()].map((s) => [...s].sort().join('|')));
    return sigs.size > 1;
}

// ---------------------------------------------------------------- rendering

function svgMap(g, pos, focus, { forPoster = false } = {}) {
    const ink = forPoster ? '#2b2722' : 'var(--kts-ink)';
    const panel = forPoster ? '#ffffff' : 'var(--kts-station)';
    const sub = forPoster ? '#8b8479' : 'var(--kts-sub)';
    const font = "Pretendard, 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";
    const near = new Set();
    if (focus) for (const e of g.edges) { if (e.a === focus) near.add(e.b); if (e.b === focus) near.add(e.a); }
    const lines = g.edges.map((e, i) => {
        const a = pos.get(e.a); const b = pos.get(e.b);
        const on = !focus || e.a === focus || e.b === focus;
        const color = e.type[2];
        const dash = differs(e) ? ' stroke-dasharray="14 7"' : '';
        let label = '';
        if (focus && on) {
            const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
            const t = cut(tr(e.items[0].text), 12);
            label = `<g><rect x="${mx - t.length * 6.5 - 8}" y="${my - 12}" width="${t.length * 13 + 16}" height="24" rx="12" fill="${panel}" stroke="${color}" stroke-width="2"/><text x="${mx}" y="${my + 5}" text-anchor="middle" font-family="${font}" font-size="13" font-weight="600" fill="${ink}">${esc(t)}</text></g>`;
        }
        return `<g opacity="${on ? 1 : 0.15}"><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${on && focus ? 7 : 6}" stroke-linecap="round"${dash}/>${label}</g>`;
    }).join('');
    const stations = g.nodes.map((v) => {
        const p = pos.get(v.key);
        const big = v.deg >= 3;
        const dim = focus && v.key !== focus && !near.has(v.key);
        const sel = v.key === focus;
        const r = big ? 15 : 11;
        const mark = big
            ? `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${panel}" stroke="${ink}" stroke-width="4"/><circle cx="${p.x}" cy="${p.y}" r="5" fill="${ink}"/>`
            : `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${panel}" stroke="${ink}" stroke-width="3.5"/>`;
        const halo = sel ? `<circle cx="${p.x}" cy="${p.y}" r="${r + 9}" fill="#e07a5f" opacity="0.25"/>` : '';
        const nm = cut(tr(v.name), 10);
        return `<g class="st" data-act="rel-focus" data-key="${esc(v.key)}" opacity="${dim ? 0.25 : 1}" style="cursor:pointer">${halo}${mark}
            <text x="${p.x}" y="${p.y + r + 20}" text-anchor="middle" font-family="${font}" font-size="${big ? 19 : 16}" font-weight="${big ? 800 : 600}" fill="${ink}" paint-order="stroke" stroke="${panel}" stroke-width="5">${esc(nm)}</text>
            ${v.role && big ? `<text x="${p.x}" y="${p.y + r + 37}" text-anchor="middle" font-family="${font}" font-size="11" fill="${sub}" paint-order="stroke" stroke="${panel}" stroke-width="4">${esc(cut(tr(v.role), 14))}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="kts-rel-svg" viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">${lines}${stations}</svg>`;
}

function chatName(id) { return cut(title(id, state.rel.avatar), 18); }

function chatList(ids) {
    return ids.length > 2 ? `${chatName(ids[0])} 외 ${ids.length - 1}개 역` : ids.map(chatName).join(', ');
}

// the same sentence written in several chats (a branch copies its parent's memory) becomes one row
function merged(items) {
    const out = new Map();
    for (const it of items) {
        const k = `${it.from}|${it.to}|${it.text}`;
        if (!out.has(k)) out.set(k, { ...it, chats: [] });
        if (!out.get(k).chats.includes(it.chat)) out.get(k).chats.push(it.chat);
    }
    return [...out.values()];
}

function focusHtml(g, key) {
    const v = g.nodes.find((n) => n.key === key);
    if (!v) return '';
    const name = (k) => tr(g.nodes.find((n) => n.key === k)?.name || k);
    const rows = g.edges.filter((e) => e.a === key || e.b === key).map((e) => {
        const other = e.a === key ? e.b : e.a;
        const many = state.rel.scope === 'all' && state.rel.chats.length > 1;
        const items = merged(e.items).map((it) => {
            const dir = it.both ? '↔' : it.from === key ? '→' : '←';
            const kind = typeOf(it.text);
            const edit = state.rel.ko ? ` <button class="kts-rel-edit" data-act="rel-edit" data-src="${esc(it.text)}" title="번역 고치기">✏️</button>` : '';
            return `<li><span class="dir">${dir}</span> ${esc(tr(it.text))}${edit} <small><span title="이 문장만 보면 ${kind[1]}">${kind[1].split(' ')[0]}</span> ${it.src}${many ? ` · ${esc(chatList(it.chats))}` : ''}</small></li>`;
        }).join('');
        const pk = `${e.a}|${e.b}`;
        const picker = [...REL_TYPES, OTHER].map((t) => `<button class="kts-rel-set ${e.type === t ? 'on' : ''}" style="--c:${t[2]}" data-act="rel-set" data-pair="${esc(pk)}" data-v="${t[0]}" title="이 관계를 ${t[1]}(으)로 확정">${t[1].split(' ')[0]}</button>`).join('')
            + (e.fixed ? `<button class="kts-rel-set auto" data-act="rel-set" data-pair="${esc(pk)}" data-v="" title="확정을 풀고 자동으로">자동</button>` : '');
        return `<div class="kts-rel-pair ${differs(e) ? 'diff' : ''}"><b>${esc(name(other))}</b>${e.fixed ? `<span class="kts-tag" style="color:${e.type[2]}">📌 ${e.type[1]} 확정</span>` : ''}${textDiffers(e) ? '<span class="kts-tag reason">🔀 지선마다 다름</span>' : ''}<div class="kts-rel-pick">${picker}</div><ul>${items}</ul></div>`;
    }).join('');
    const others = g.nodes.filter((n) => n.key !== key).sort((a, b) => a.name.localeCompare(b.name));
    const merge = `<select id="kts-rel-merge" class="kts-pill"><option value="">🔗 같은 사람으로 합치기…</option>${others.map((n) => `<option value="${esc(n.key)}">${esc(cut(tr(n.name), 24))}</option>`).join('')}</select>`;
    const also = [...(v.also || [])].map((nm) => `<button class="kts-rel-set auto" data-act="rel-unmerge" data-k="${esc(keyOf(nm))}" title="다른 사람으로 다시 나누기">${esc(cut(nm, 16))} ✕</button>`).join('');
    return `<div class="kts-rel-side"><h4>${esc(tr(v.name))}${state.rel.ko ? ` <button class="kts-rel-edit" data-act="rel-edit" data-src="${esc(v.name)}" title="이름 번역 고치기">✏️</button>` : ''}${v.role ? ` <small>${esc(tr(v.role))}</small>${state.rel.ko ? ` <button class="kts-rel-edit" data-act="rel-edit" data-src="${esc(v.role)}" title="역할 번역 고치기">✏️</button>` : ''}` : ''}</h4>
        <div class="kts-rel-pick">${also ? `<small class="kts-muted">같은 사람: </small>${also}` : ''}${merge}</div>
        ${rows || '<p class="kts-muted">이어진 관계가 없어요.</p>'}</div>`;
}

function diffListHtml(g) {
    const name = (k) => tr(g.nodes.find((n) => n.key === k)?.name || k);
    const list = g.edges.filter(textDiffers);
    if (!list.length) return `<div class="kts-rel-side"><p class="kts-muted">역(사람)을 누르면 그 인물의 관계가 나와요.${state.rel.chats.length > 1 ? ' 지선마다 관계가 다르게 적힌 쌍은 점선으로 그려요.' : ''}</p></div>`;
    return `<div class="kts-rel-side"><h4>🔀 지선마다 달라진 관계 <small>${list.length}쌍</small></h4>${list.slice(0, 12).map((e) => {
        // chats that wrote the same thing are shown together: only the real differences remain
        const by = new Map();
        for (const it of e.items) { if (!by.has(it.chat)) by.set(it.chat, new Set()); by.get(it.chat).add(it.text); }
        const variants = new Map();
        for (const [chat, texts] of by) { const sig = [...texts].sort().join(' / '); if (!variants.has(sig)) variants.set(sig, []); variants.get(sig).push(chat); }
        return `<div class="kts-rel-pair diff"><b>${esc(name(e.a))} · ${esc(name(e.b))}</b><span class="kts-tag" style="color:${e.type[2]}">${e.fixed ? '📌 ' : ''}${e.type[1]}${e.fixed ? ' 확정' : ''}</span><ul>${[...variants].map(([sig, chats]) => `<li>${esc(cut(sig.split(' / ').map(tr).join(' / '), 90))}<br><small>🚉 ${esc(chatList(chats))}</small></li>`).join('')}</ul></div>`;
    }).join('')}</div>`;
}

export function relHtml() {
    const r = state.rel;
    if (!r) return '';
    const bot = charByAvatar(r.avatar)?.char?.name || '';
    const top = (extra = '') => `<div class="kts-toolbar"><button class="kts-pill" data-act="rel-close">← 돌아가기</button><span class="kts-cur">🕸️ 관계 노선도<small>${esc(cut(bot, 14))}</small></span>${extra}</div>`;
    if (r.loading) return top() + '<div class="kts-empty">인물과 관계를 모으는 중… 🕸️</div>';
    if (r.error) return top() + `<div class="kts-empty">${esc(r.error)}</div>`;
    if (!r.chats?.length) {
        return top() + `<div class="kts-empty">아직 그릴 관계가 없어요.<br><small>🐘 코끼리를 생각하지마의 <b>기록부(관계)</b>나 📚 메모리아의 <b>인물 관계</b>에 적힌 내용으로 그려요.<br>이 봇의 챗에서 두 확장 중 하나로 기록이 쌓이면 여기 나타나요.</small></div>`;
    }
    const opts = [`<option value="all" ${r.scope === 'all' ? 'selected' : ''}>모든 역 합쳐 보기 (${r.chats.length})</option>`,
        ...r.chats.map((c) => `<option value="${esc(c.id)}" ${r.scope === c.id ? 'selected' : ''}>${esc(chatName(c.id))}</option>`)].join('');
    const mobile = (window.innerWidth || 1000) <= 760;
    const limit = r.limit || 16;
    const off = r.off || (r.off = new Set());
    const has = (k) => r.chats.some((c) => c.rels.some((x) => x.src === k));
    const srcChips = [['🐘', '코끼리'], ['📚', '메모리아']].filter(([k]) => has(k)).map(([k, label]) => `<button class="kts-pill kts-rel-type ${sources().has(k) ? '' : 'off'}" data-act="rel-src" data-v="${k}" title="${extOn(k) ? '켜져 있는 확장' : '지금은 꺼져 있는 확장의 예전 기록'}">${k} ${label}${extOn(k) ? '' : ' (꺼짐)'}</button>`).join('');
    const g = buildGraph(scopedChats(), { limit, off });
    if (!g.nodes.length) return top() + `<div class="kts-rel-types">${srcChips}</div><div class="kts-empty">이 역에는 (고른 기록·종류의) 관계가 없어요.</div>`;
    W = mobile ? 480 : 860;
    H = Math.max(mobile ? 640 : 560, (mobile ? 260 : 220) + g.nodes.length * (mobile ? 30 : 22));
    const cacheKey = `${r.scope}|${limit}|${[...off].sort()}|${W}x${H}|${JSON.stringify(pairStore())}|${JSON.stringify(aliasStore())}|${[...sources()]}`;
    if (r.last?.key !== cacheKey) r.last = { key: cacheKey, g, pos: layout(g.nodes, g.edges) };
    const { pos } = r.last;
    const G = r.last.g;
    if (r.focus && !G.nodes.some((n) => n.key === r.focus)) r.focus = null;
    const limitOpts = LIMITS.map((n) => `<option value="${n}" ${limit === n ? 'selected' : ''}>${n === 60 ? '인물 전부' : `핵심 인물 ${n}명`}</option>`).join('');
    const typeChips = [...REL_TYPES, OTHER].filter((t) => g.typesUsed.has(t) || off.has(t[0])).map((t) => `<button class="kts-pill kts-rel-type ${off.has(t[0]) ? 'off' : ''}" style="--c:${t[2]}" data-act="rel-type" data-v="${t[0]}"><i></i>${t[1]}</button>`).join('');
    return top(`<select id="kts-rel-scope" class="kts-pill">${opts}</select><select id="kts-rel-limit" class="kts-pill">${limitOpts}</select><button class="kts-pill ${r.ko ? 'on' : ''}" data-act="rel-ko" title="관계와 이름을 한국어로 보여줘요. 처음 한 번만 요약용 연결 프로필로 번역하고, 그다음부터는 저장된 번역을 써요.">${r.translating ? `🇰🇷 번역 중 ${r.translating.done}/${r.translating.total}` : r.ko ? (missingKo(G) ? `🇰🇷 새 문장 ${missingKo(G)}개 번역` : '🇰🇷 한글 ✓') : '🇰🇷 한글로'}</button><button class="kts-pill" data-act="rel-png" title="관계 노선도를 PNG로 저장">🖼️ PNG</button>`)
        + `<div class="kts-rel-types">${srcChips ? `<span class="kts-muted lbl">기록:</span>${srcChips}<span class="sep"></span>` : ''}${typeChips}</div>
        <div class="kts-rel">
            <div class="kts-rel-map">${svgMap(G, pos, r.focus)}
                <div class="kts-rel-legend">인물 ${G.nodes.length}명 · 관계 ${G.edges.length}개${G.hidden ? ` · 관계가 적은 ${G.hidden}명은 생략` : ''} · <span class="dash">┅</span> 지선마다 다른 관계 · 색 = 관계 종류 (눌러서 끄고 켜기)</div></div>
            ${r.focus ? focusHtml(G, r.focus) : diffListHtml(G)}
        </div>`;
}

// ---------------------------------------------------------------- 🇰🇷 translate

function missingKo(g) {
    if (!g) return 0;
    const store = koStore();
    const want = new Set();
    for (const v of g.nodes) { want.add(v.name); if (v.role) want.add(v.role); }
    for (const e of g.edges) for (const it of e.items) want.add(it.text);
    return [...want].filter((t) => t && !store[t] && /[A-Za-z]/.test(t)).length;
}

async function translateAll() {
    const r = state.rel;
    const g = r.last?.g;
    if (!g) return;
    const store = koStore();
    const want = new Set();
    for (const v of g.nodes) { want.add(v.name); if (v.role) want.add(v.role); }
    for (const e of g.edges) for (const it of e.items) want.add(it.text);
    const todo = [...want].filter((t) => t && !store[t] && /[A-Za-z]/.test(t));
    if (!todo.length) { r.ko = true; app.render(); return; }
    r.translating = { done: 0, total: todo.length };
    app.render();
    const system = 'You translate short notes about characters in a story into natural Korean. Character names: use the usual Korean spelling (e.g. Harry Potter -> 해리 포터, Hermione -> 헤르미온느). Keep it short. Do not add explanations.';
    try {
        for (let i = 0; i < todo.length; i += 60) {
            const batch = todo.slice(i, i + 60);
            const user = `Translate each numbered line into Korean. Answer with the same numbers, one per line, in the form "N. translation", nothing else.\n\n${batch.map((t, j) => `${j + 1}. ${t.replace(/\s+/g, ' ')}`).join('\n')}`;
            const out = String(await callModel(system, user, 4000) || '');
            for (const line of out.split(/\n/)) {
                const m = line.match(/^\s*(\d+)[.)]\s*(.+?)\s*$/);
                if (!m) continue;
                const src = batch[Number(m[1]) - 1];
                if (src && m[2]) store[src] = m[2].replace(/^["']|["']$/g, '');
            }
            r.translating.done = Math.min(todo.length, i + batch.length);
            save();
            app.render();
        }
        r.ko = true;
    } catch (err) {
        console.error(LOG, err);
        toastr.error(`번역하지 못했어요: ${errText(err)}`, TOAST);
    }
    r.translating = null;
    save();
    app.render();
}

// ---------------------------------------------------------------- PNG

async function savePng() {
    const r = state.rel;
    if (!r?.last) return;
    const bot = charByAvatar(r.avatar)?.char?.name || 'bot';
    const inner = svgMap(r.last.g, r.last.pos, r.focus, { forPoster: true }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const font = "Pretendard, 'Noto Sans KR', sans-serif";
    const PH = H + 120;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PH}" viewBox="0 0 ${W} ${PH}">
        <rect width="${W}" height="${PH}" fill="#f7f3ec"/>
        <text x="40" y="58" font-family="${font}" font-size="30" font-weight="800" fill="#2b2722">${esc(cut(bot, 20))} 관계 노선도</text>
        <text x="40" y="86" font-family="${font}" font-size="14" fill="#8b8479">${esc(r.scope === 'all' ? `모든 역 ${r.chats.length}개 합침` : chatName(r.scope))}</text>
        <g transform="translate(0,100)">${inner}</g>
        <text x="${W - 40}" y="${PH - 20}" text-anchor="end" font-family="${font}" font-size="14" font-weight="700" fill="#e07a5f">🚇 깡통 노선도</text>
    </svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = W * 2;
        canvas.height = PH * 2;
        const g2 = canvas.getContext('2d');
        g2.scale(2, 2);
        g2.drawImage(img, 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${String(bot).replace(/[\\/:*?"<>|]+/g, '_')}_관계노선도.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toastr.success('관계 노선도를 저장했어요.', TOAST);
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ---------------------------------------------------------------- events

export async function relClick(act, el) {
    const r = state.rel;
    switch (act) {
        case 'rel-open': await openRel(state.avatar); return true;
        case 'rel-close': state.view = 'main'; state.rel = null; app.render(); return true;
        case 'rel-focus': if (r) { r.focus = r.focus === el.dataset.key ? null : el.dataset.key; app.render(); } return true;
        case 'rel-set': {
            const store = pairStore();
            if (el.dataset.v) store[el.dataset.pair] = el.dataset.v; else delete store[el.dataset.pair];
            save();
            if (r) r.last = null; // redraw with the new color
            app.render();
            return true;
        }
        case 'rel-unmerge': {
            const store = aliasStore();
            store[el.dataset.k] = el.dataset.k; // keep this name apart, even from the automatic merge
            save();
            if (r) r.last = null;
            app.render();
            return true;
        }
        case 'rel-src': {
            const src = sources();
            const k = el.dataset.v;
            if (src.has(k)) { if (src.size > 1) src.delete(k); } else src.add(k);
            getSettings().relSources = [...src];
            save();
            r.last = null; r.focus = null;
            app.render();
            return true;
        }
        case 'rel-ko':
            if (r.translating) return true;
            if (r.ko && !missingKo(r.last?.g)) { r.ko = false; getSettings().relKoOn = false; save(); app.render(); return true; }
            await translateAll();
            getSettings().relKoOn = !!r.ko;
            save();
            return true;
        case 'rel-edit': {
            const src = el.dataset.src;
            const store = koStore();
            const v = await ctx().Popup.show.input('🇰🇷 번역 고치기', `원문: ${esc(src)}<br><small>비우고 확인하면 원문 그대로 보여줘요.</small>`, store[src] || '');
            if (v === null || v === undefined || v === false) return true;
            const t = String(v).trim();
            if (t) store[src] = t; else store[src] = src;
            save();
            if (r) r.last = null;
            app.render();
            return true;
        }
        case 'rel-type': if (r) { const k = el.dataset.v; if (r.off.has(k)) r.off.delete(k); else r.off.add(k); r.focus = null; app.render(); } return true;
        case 'rel-png': try { await savePng(); } catch (err) { console.error(LOG, err); toastr.error('PNG를 만들지 못했어요.', TOAST); } return true;
    }
    return false;
}

export function relChange(ev) {
    if (ev.target.id === 'kts-rel-merge' && state.rel?.focus && ev.target.value) {
        const store = aliasStore();
        const from = state.rel.focus;
        const to = ev.target.value;
        store[from] = to;
        for (const [k, v] of Object.entries(store)) if (v === from && k !== from) store[k] = to;
        if (store[to] === to) delete store[to];
        save();
        state.rel.focus = to;
        state.rel.last = null;
        app.render();
        return true;
    }
    if (ev.target.id === 'kts-rel-limit' && state.rel) { state.rel.limit = Number(ev.target.value) || 16; state.rel.focus = null; app.render(); return true; }
    if (ev.target.id !== 'kts-rel-scope' || !state.rel) return false;
    state.rel.scope = ev.target.value;
    state.rel.focus = null;
    app.render();
    return true;
}
