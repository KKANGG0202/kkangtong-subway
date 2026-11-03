// 깡통 노선도 - "🎫 중복 검표" tab: finds duplicated / renewed copies of the same character and shows what differs.
// View only: nothing here changes or deletes a card.

import { LOG, TOAST, state, app, ctx, esc, cut, fmtAgo, fmtBytes, parseDate, avatarUrl, charByAvatar, getSettings, save } from './core.js';
import { loadHub } from './hub.js';

// ---------------------------------------------------------------- small helpers

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const str = (v) => (v == null ? '' : String(v));

function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
}

function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ':' + bytes.length;
}

// Sorted-key JSON so key order never counts as a difference.
function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v ?? null);
}

// "Alice (1)", "alice_v2", "Alice 복사본", "Alice2" → "alice"
export function normName(s) {
    let t = str(s).toLowerCase().normalize('NFKC');
    t = t.replace(/\.(png|json|charx|webp)$/, '');
    t = t.replace(/[(\[{（【「<].*?[)\]}）】」>]/g, ' ');
    t = t.replace(/(복사본|사본|테스트|리뉴얼|수정본|배포용|백업)/g, ' ');
    t = t.replace(/(^|[^a-z])(copy|clone|test|backup|renewal|new|old|ver\.?\s*\d*|v\s*\d+(\.\d+)*)(?=$|[^a-z])/g, '$1 ');
    t = t.replace(/[\s_\-.·~!@#$%^&*+=|:;'",/?\\]+/g, '');
    t = t.replace(/\d+$/, '');
    return t;
}

const normText = (s) => str(s).replace(/\{\{(char|user)\}\}/gi, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- loading cards

async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return res.json();
}

// With ST's lazy loading on, the character list only has names; the full card is fetched then.
async function fullCard(ch) {
    if (!ch.shallow && ch.data) return ch;
    try { return await postJson('/api/characters/get', { avatar_url: ch.avatar }); } catch (err) { console.warn(LOG, err); return ch; }
}

async function pool(items, n, fn, onStep) {
    const out = new Array(items.length);
    let next = 0;
    const work = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
            onStep?.();
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, work));
    return out;
}

// ---------------------------------------------------------------- grouping
//
// Cards are compared by their actual content, not by a shared name or a shared opening:
// - every card is cut into sentences/lines (its own name and {{char}}/{{user}} removed, so renamed copies still match)
// - lines that many different cards share (a house template, a common system block) count for nothing
// - two cards are "the same bot" when most of their remaining lines match
// - a group is one base card plus the cards that match *it* directly, so A~B and B~C never drag A and C together

const CONTENT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'];
const STRONG = 0.45;      // 내용 45% 이상 같으면 같은 봇
const CONTAINED = 0.8;    // 또는 작은 쪽 카드 내용의 80%가 큰 쪽에 그대로 있으면 (내용을 늘린 리뉴얼)
const NAME_WITH = 0.15;   // 이름이 같으면 내용이 15%만 겹쳐도 같은 봇으로
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function segmentsOf(c) {
    let text = CONTENT_FIELDS.map((p) => field(c, p)).join('\n') + '\n' + (c.data?.alternate_greetings || []).map(str).join('\n');
    text = text.replace(/\{\{(char|user)\}\}/gi, ' ');
    // "레온 (1)", "레온_v2", "레온 복사본" all still write "레온" in their text: remove the bare name too
    const bare = (x) => x.replace(/[(\[{（【「<].*?[)\]}）】」>]/g, ' ').replace(/(복사본|사본|테스트|리뉴얼|수정본|copy|clone|test)/gi, ' ').replace(/[\s_\-.]*v?\d+(\.\d+)*\s*$/i, '').trim();
    const names = [str(c.name), str(c.data?.name)].map((x) => x.trim()).flatMap((x) => [x, bare(x)]).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
    for (const n of new Set(names)) text = text.replace(new RegExp(escRe(n), 'gi'), ' ');
    const out = new Set();
    for (const raw of text.split(/[\n.!?。…]+/)) {
        const t = raw.toLowerCase().normalize('NFKC').replace(/[\s"'`*_~<>\[\](){}:;,·\-–—|/\\]+/g, '');
        if (t.length >= 8) out.add(hash(t));
    }
    return out;
}

function buildIndex(cards) {
    const segs = cards.map(segmentsOf);
    const df = new Map();
    for (const set of segs) for (const h of set) df.set(h, (df.get(h) || 0) + 1);
    // a line in this many cards is template text, not this bot
    const boiler = Math.max(6, Math.ceil(cards.length * 0.03));
    const N = cards.length;
    const weight = (h) => { const d = df.get(h) || 1; return d >= boiler ? 0 : Math.log(1 + N / d); };
    const fps = segs.map((set) => {
        const w = new Map();
        let total = 0;
        for (const h of set) { const x = weight(h); if (x > 0) { w.set(h, x); total += x; } }
        return { w, total };
    });
    return { fps, df, boiler };
}

/** { score: weighted share of all lines (0–1), contained: share of the smaller card found in the other } */
function similarity(a, b) {
    if (!a || !b || !a.total || !b.total) return { score: 0, contained: 0 };
    const [small, big] = a.w.size <= b.w.size ? [a, b] : [b, a];
    let shared = 0;
    for (const [h, x] of small.w) if (big.w.has(h)) shared += x;
    const union = a.total + b.total - shared;
    return { score: union ? shared / union : 0, contained: shared / Math.min(a.total, b.total) };
}

function nameKey(c) {
    const k = normName(c?.name);
    return k.length >= 2 ? k : '';
}

const isStrong = (sim) => sim.score >= STRONG || sim.contained >= CONTAINED;

function groupCards(cards) {
    const { fps, df, boiler } = buildIndex(cards);
    const N = cards.length;
    // candidate pairs: cards that share at least one non-template line, plus cards with the same name
    const pairs = new Set();
    const byLine = new Map();
    fps.forEach((fp, i) => { for (const h of fp.w.keys()) { if (!byLine.has(h)) byLine.set(h, []); byLine.get(h).push(i); } });
    for (const list of byLine.values()) {
        if (list.length < 2 || list.length >= boiler) continue;
        for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) pairs.add(list[x] * N + list[y]);
    }
    const byName = new Map();
    cards.forEach((c, i) => { const k = nameKey(c); if (!k) return; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); });
    for (const list of byName.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) pairs.add(list[x] * N + list[y]);

    const links = cards.map(() => new Map()); // i -> Map(j -> sim)
    for (const key of pairs) {
        const i = Math.floor(key / N);
        const j = key % N;
        const sim = similarity(fps[i], fps[j]);
        const sameName = !!nameKey(cards[i]) && nameKey(cards[i]) === nameKey(cards[j]);
        if (isStrong(sim) || (sameName && sim.score >= NAME_WITH)) {
            links[i].set(j, sim);
            links[j].set(i, sim);
        }
    }

    // base = the most recently ridden card; members must match the base itself
    const order = cards.map((_, i) => i).sort((a, b) => lastRide(cards[b].avatar) - lastRide(cards[a].avatar));
    const taken = new Set();
    const groups = [];
    for (const i of order) {
        if (taken.has(i) || !links[i].size) continue;
        const members = [i, ...[...links[i].keys()].filter((j) => !taken.has(j))];
        if (members.length < 2) continue;
        members.forEach((m) => taken.add(m));
        groups.push({ members: members.map((m) => cards[m].avatar) });
    }

    // same name, different content: shown apart so they don't look like copies
    const nameOnly = [];
    for (const list of byName.values()) {
        if (list.length < 2) continue;
        // one card per group (its base) plus every card left out: these are the ones that really differ
        const reps = [];
        const seen = new Set();
        for (const i of list) {
            const gi = groups.findIndex((g) => g.members.includes(cards[i].avatar));
            if (gi < 0) reps.push(cards[i].avatar);
            else if (!seen.has(gi)) { seen.add(gi); reps.push(groups[gi].members[0]); }
        }
        if (reps.length >= 2) nameOnly.push(reps);
    }
    return { groups, nameOnly, fps: new Map(cards.map((c, i) => [c.avatar, fps[i]])), df };
}

// ---------------------------------------------------------------- diffing

const TEXT_FIELDS = [
    ['description', '설명'],
    ['personality', '성격'],
    ['scenario', '시나리오'],
    ['first_mes', '첫 메시지'],
    ['mes_example', '예시 대화'],
    ['system_prompt', '시스템 프롬프트'],
    ['post_history_instructions', '탈옥(PHI)'],
    ['extensions.depth_prompt.prompt', '캐릭터 노트'],
    ['creator_notes', '제작자 메모'],
];

const field = (c, path) => str(get(c.data, path) ?? get(c, path));

/** How many characters were added/removed between two texts, plus a short look at the first change. */
export function textDiff(a, b) {
    a = str(a); b = str(b);
    if (a === b) return null;
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a[p] === b[p]) p++;
    let s = 0;
    while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const am = a.slice(p, a.length - s);
    const bm = b.slice(p, b.length - s);
    let matched = 0;
    if (am.length && bm.length && am.length * bm.length <= 4e6) {
        // exact character-level LCS on the changed middle part
        let prev = new Uint16Array(bm.length + 1);
        let cur = new Uint16Array(bm.length + 1);
        for (let i = 1; i <= am.length; i++) {
            const ch = am.charCodeAt(i - 1);
            for (let j = 1; j <= bm.length; j++) {
                cur[j] = ch === bm.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
            }
            [prev, cur] = [cur, prev];
        }
        matched = prev[bm.length];
    } else if (am.length && bm.length) {
        // big rewrites: compare whole sentences/lines instead
        const seg = (t) => t.split(/(?<=[\n.!?。…])/).filter(Boolean);
        const A = seg(am);
        const B = seg(bm);
        if (A.length * B.length <= 2e6) {
            let prev = new Float64Array(B.length + 1);
            let cur = new Float64Array(B.length + 1);
            for (let i = 1; i <= A.length; i++) {
                for (let j = 1; j <= B.length; j++) {
                    cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + A[i - 1].length : Math.max(prev[j], cur[j - 1]);
                }
                [prev, cur] = [cur, prev];
            }
            matched = prev[B.length];
        }
    }
    return {
        del: am.length - matched,
        add: bm.length - matched,
        from: cut(am.trim(), 70),
        to: cut(bm.trim(), 70),
    };
}

// --- lorebook entries (embedded book and linked World Info files use different shapes)

function normEntry(e) {
    const keys = (e.keys ?? e.key ?? []).map((k) => str(k).trim()).filter(Boolean).sort();
    const sec = (e.secondary_keys ?? e.keysecondary ?? []).map((k) => str(k).trim()).filter(Boolean).sort();
    const label = str(e.comment || e.name).trim() || keys[0] || cut(str(e.content).trim(), 20) || '(이름 없음)';
    const settings = stable({
        sec,
        off: !!(e.disable ?? (e.enabled === false)),
        constant: !!e.constant,
        order: e.order ?? e.insertion_order ?? null,
        position: e.position ?? null,
        depth: e.depth ?? e.extensions?.depth ?? null,
    });
    return { k: keys.join('\u0001') + '\u0002' + label, c: str(e.content), s: settings, label };
}

// Pairs up two lists of named items: exact copies first, then same name, then same body.
function diffItems(A, B) {
    const a = [...A];
    const b = [...B];
    const take = (match) => {
        const pairs = [];
        for (let i = a.length - 1; i >= 0; i--) {
            const j = b.findIndex((y) => match(a[i], y));
            if (j >= 0) { pairs.push([a[i], b[j]]); a.splice(i, 1); b.splice(j, 1); }
        }
        return pairs;
    };
    const same = take((x, y) => x.k === y.k && x.c === y.c && x.s === y.s).length;
    const changed = [...take((x, y) => x.k === y.k), ...take((x, y) => x.c === y.c && x.c !== '')].map(([x]) => x.label);
    return { same, changed, removed: a.map((x) => x.label), added: b.map((x) => x.label), total: A.length };
}

const isDiff = (d) => d && (d.changed.length || d.removed.length || d.added.length);

// --- scripts

function flattenScripts(list, out = []) {
    for (const s of list || []) {
        if (!s || typeof s !== 'object') continue;
        if (Array.isArray(s.scripts)) flattenScripts(s.scripts, out);
        else out.push(s);
    }
    return out;
}

const normRegex = (r) => {
    const { id, ...rest } = r;
    return { k: str(r.scriptName).trim() || cut(str(r.findRegex), 20), c: stable(rest), s: '', label: str(r.scriptName).trim() || cut(str(r.findRegex), 20) || '(이름 없음)' };
};
const normTh = (r) => {
    const { id, ...rest } = r;
    const label = str(r.name).trim() || '(이름 없음)';
    return { k: label, c: stable(rest), s: '', label };
};

const thScripts = (c) => {
    const ext = c.data?.extensions || {};
    return flattenScripts(ext.tavern_helper?.scripts ?? ext.TavernHelper_scripts ?? []);
};

const KNOWN_EXT = new Set(['world', 'fav', 'depth_prompt', 'regex_scripts', 'tavern_helper', 'TavernHelper_scripts', 'TavernHelper_characterScriptVariables']);

// ---------------------------------------------------------------- async parts (World Info files, avatar images)

const worldCache = new Map();
async function worldEntries(name) {
    if (!name) return null;
    if (!worldCache.has(name)) {
        worldCache.set(name, postJson('/api/worldinfo/get', { name })
            .then((w) => Object.values(w?.entries || {}).map(normEntry))
            .catch((err) => { console.warn(LOG, err); return null; }));
    }
    return worldCache.get(name);
}

const imgCache = new Map();
async function imageHash(avatar) {
    if (!imgCache.has(avatar)) {
        imgCache.set(avatar, fetch(avatarUrl(avatar), { cache: 'force-cache' })
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .then((buf) => (buf ? hashBytes(new Uint8Array(buf)) : null))
            .catch(() => null));
    }
    return imgCache.get(avatar);
}

// ---------------------------------------------------------------- compare one card against the base card

// How close this card is to the base card (checked pair by pair, not for the whole group).
function pairInfo(baseAv, otherAv) {
    const tw = state.twins;
    const sim = similarity(tw.fps.get(baseAv), tw.fps.get(otherAv));
    const sameName = !!nameKey(tw.cards.get(baseAv)) && nameKey(tw.cards.get(baseAv)) === nameKey(tw.cards.get(otherAv));
    return { pct: Math.round(sim.score * 100), contained: Math.round(sim.contained * 100), sameName };
}

const cardEmpty = (c) => !c || TEXT_FIELDS.every(([path]) => !field(c, path).trim());

function compareSync(base, other) {
    const items = [];
    if (str(base.name) !== str(other.name)) items.push({ kind: 'info', label: '이름', text: `${cut(base.name, 20)} → ${cut(other.name, 20)}` });

    for (const [path, label] of TEXT_FIELDS) {
        const d = textDiff(field(base, path), field(other, path));
        if (d) items.push({ kind: 'text', label, ...d });
    }

    const ga = (base.data?.alternate_greetings || []).map(str);
    const gb = (other.data?.alternate_greetings || []).map(str);
    if (stable(ga) !== stable(gb)) {
        const asItems = (g) => g.map((t, i) => ({ k: t, c: t, s: '', label: `${i + 1}번` }));
        const d = diffItems(asItems(ga), asItems(gb));
        items.push({ kind: 'list', label: '추가 인사말', total: `${ga.length}개 → ${gb.length}개`, d });
    }

    const ta = new Set((base.tags || base.data?.tags || []).map(str));
    const tb = new Set((other.tags || other.data?.tags || []).map(str));
    const tagAdd = [...tb].filter((t) => !ta.has(t));
    const tagDel = [...ta].filter((t) => !tb.has(t));
    if (tagAdd.length || tagDel.length) items.push({ kind: 'info', label: '카드 태그', text: [tagAdd.length ? `+${tagAdd.join(', ')}` : '', tagDel.length ? `−${tagDel.join(', ')}` : ''].filter(Boolean).join(' / ') });

    const ra = (base.data?.extensions?.regex_scripts || []).map(normRegex);
    const rb = (other.data?.extensions?.regex_scripts || []).map(normRegex);
    const rd = diffItems(ra, rb);
    if (isDiff(rd)) items.push({ kind: 'list', label: '정규식', total: `${ra.length}개 → ${rb.length}개`, d: rd });

    const sa = thScripts(base).map(normTh);
    const sb = thScripts(other).map(normTh);
    const sd = diffItems(sa, sb);
    if (isDiff(sd)) items.push({ kind: 'list', label: 'TH 스크립트', total: `${sa.length}개 → ${sb.length}개`, d: sd });
    const va = base.data?.extensions?.TavernHelper_characterScriptVariables ?? base.data?.extensions?.tavern_helper?.variables;
    const vb = other.data?.extensions?.TavernHelper_characterScriptVariables ?? other.data?.extensions?.tavern_helper?.variables;
    if (stable(va ?? {}) !== stable(vb ?? {})) items.push({ kind: 'info', label: 'TH 변수', text: '다름' });

    const ba = (base.data?.character_book?.entries || []).map(normEntry);
    const bb = (other.data?.character_book?.entries || []).map(normEntry);
    const bd = diffItems(ba, bb);
    if (isDiff(bd)) items.push({ kind: 'list', label: '내장 로어북', total: `${ba.length}개 → ${bb.length}개`, d: bd });

    const ea = base.data?.extensions || {};
    const eb = other.data?.extensions || {};
    const extra = [...new Set([...Object.keys(ea), ...Object.keys(eb)])].filter((k) => !KNOWN_EXT.has(k) && stable(ea[k]) !== stable(eb[k]));
    if (extra.length) items.push({ kind: 'info', label: '기타 확장 데이터', text: extra.join(', ') });

    return items;
}

async function compareAsync(base, other) {
    const items = [];
    const wa = str(base.data?.extensions?.world);
    const wb = str(other.data?.extensions?.world);
    if (wa !== wb) {
        if (!wa || !wb) {
            items.push({ kind: 'info', label: '월드인포', text: wa ? `연결 없음 (기준: ${cut(wa, 24)})` : `${cut(wb, 24)} 연결됨 (기준: 없음)` });
        } else {
            const [A, B] = await Promise.all([worldEntries(wa), worldEntries(wb)]);
            if (!A || !B) items.push({ kind: 'info', label: '월드인포', text: `${cut(wa, 20)} → ${cut(wb, 20)} (파일을 못 읽었어요)` });
            else {
                const d = diffItems(A, B);
                if (isDiff(d)) items.push({ kind: 'list', label: '월드인포', total: `${cut(wa, 16)} ${A.length}개 → ${cut(wb, 16)} ${B.length}개`, d });
                else items.push({ kind: 'note', label: '월드인포', text: `다른 파일이지만 항목은 똑같아요 (${cut(wa, 16)} / ${cut(wb, 16)})` });
            }
        }
    }
    const [ia, ib] = await Promise.all([imageHash(base.avatar), imageHash(other.avatar)]);
    if (ia && ib && ia !== ib) items.push({ kind: 'info', label: '이미지', text: '다름' });
    return items;
}

// ---------------------------------------------------------------- scan

export async function scanTwins(force = false) {
    const tw = state.twins || (state.twins = { groups: null, open: new Set(), base: {}, results: {}, query: '', sel: new Set() });
    if (tw.loading || (tw.groups && !force)) return;
    tw.loading = true;
    tw.done = 0;
    loadHub();
    const list = (ctx().characters || []).filter((c) => c?.avatar);
    tw.total = list.length;
    app.render();
    let tick = 0;
    try {
        const cards = await pool(list, 6, fullCard, () => { tw.done++; if (++tick % 10 === 0) app.render(); });
        tw.cards = new Map(cards.map((c) => [c.avatar, c]));
        const found = groupCards(cards);
        tw.groups = found.groups;
        tw.fps = found.fps;
        tw.nameOnly = found.nameOnly;
        tw.results = {};
        for (const g of tw.groups) {
            g.key = g.members.slice().sort().join('|');
            computeGroup(g, true);
        }
        // copies first (the easy cleanup), then the rest by name
        tw.groups.sort((a, b) => (kindOf(b) === 'copy') - (kindOf(a) === 'copy') || b.members.length - a.members.length || a.name.localeCompare(b.name));
        tw.at = Date.now();
    } catch (err) {
        console.error(LOG, err);
        toastr.error('캐릭터를 다 읽지 못했어요.');
    }
    tw.loading = false;
    app.render();
}

function lastRide(avatar) {
    const bot = state.hub?.bots?.find((b) => b.avatar === avatar);
    if (bot?.last) return bot.last;
    const c = state.twins?.cards?.get(avatar) || charByAvatar(avatar)?.char;
    return parseDate(c?.date_last_chat) || 0;
}

function computeGroup(g, syncOnly = false) {
    const tw = state.twins;
    const baseAv = tw.base[g.key] && g.members.includes(tw.base[g.key]) ? tw.base[g.key] : g.members[0];
    const base = tw.cards.get(baseAv);
    g.name = base?.name || '';
    const res = { base: baseAv, rows: {}, why: {}, broken: {}, pending: !syncOnly };
    for (const av of g.members) {
        if (av === baseAv) continue;
        const other = tw.cards.get(av);
        res.rows[av] = compareSync(base, other);
        res.why[av] = pairInfo(baseAv, av);
        res.broken[av] = cardEmpty(base) || cardEmpty(other);
    }
    tw.results[g.key] = res;
    if (syncOnly) return;
    Promise.all(g.members.filter((av) => av !== baseAv).map(async (av) => {
        const more = await compareAsync(base, tw.cards.get(av));
        if (tw.results[g.key] === res) res.rows[av] = [...res.rows[av], ...more];
    })).finally(() => {
        if (tw.results[g.key] !== res) return;
        res.pending = false;
        res.full = true;
        app.render();
    });
}

// ---------------------------------------------------------------- rendering

// 'copy' = every card in the group is the same as the base · 'edit' = renewed / modified versions
function kindOf(g) {
    const r = state.twins.results[g.key];
    if (!r) return 'edit';
    return g.members.every((a) => a === r.base || (!r.broken[a] && countDiffs(r.rows[a]) === 0)) ? 'copy' : 'edit';
}

function similarityPct(avs) {
    const tw = state.twins;
    let lo = 100;
    let hi = 0;
    for (let i = 0; i < avs.length; i++) for (let j = i + 1; j < avs.length; j++) {
        const p = Math.round(similarity(tw.fps.get(avs[i]), tw.fps.get(avs[j])).score * 100);
        lo = Math.min(lo, p); hi = Math.max(hi, p);
    }
    return lo === hi ? `${lo}%` : `${lo}~${hi}%`;
}

function simText(w) {
    if (!w) return '';
    const parts = [`내용 ${w.pct}% 같음`];
    if (w.contained >= 80 && w.pct < 80) parts.push(`작은 쪽 내용 ${w.contained}%가 들어 있음`);
    if (w.sameName) parts.push('이름 같음');
    return parts.join(' · ');
}

function countDiffs(rows) {
    return rows.filter((r) => r.kind !== 'note' && !(r.kind === 'info' && r.label === '이름')).length;
}

function memberMeta(av) {
    const c = state.twins.cards.get(av) || {};
    const bot = state.hub?.bots?.find((b) => b.avatar === av);
    const last = lastRide(av);
    const parts = [];
    if (bot) parts.push(`역 ${bot.chats}개 · 메시지 ${bot.messages.toLocaleString()}개`);
    else if (c.chat_size) parts.push(`챗 ${fmtBytes(c.chat_size)}`);
    else parts.push('챗 없음');
    parts.push(last ? `🚇 ${fmtAgo(last)} 탑승` : '탑승 기록 없음');
    const made = parseDate(c.date_added) || parseDate(c.create_date);
    if (made) { const d = new Date(made); parts.push(`🆕 ${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} 만듦`); }
    return parts.join(' · ');
}

function listLine(names, sign) {
    if (!names.length) return '';
    const shown = names.slice(0, 6).map((n) => esc(cut(n, 18))).join(', ');
    return `<span class="tw-${sign === '+' ? 'add' : sign === '−' ? 'del' : 'chg'}">${sign} ${names.length}개: ${shown}${names.length > 6 ? ' …' : ''}</span>`;
}

function rowHtml(r) {
    if (r.kind === 'text') {
        return `<li><b>${esc(r.label)}</b><span class="n"><span class="tw-add">+${r.add.toLocaleString()}</span> <span class="tw-del">−${r.del.toLocaleString()}</span> 글자</span>
            <div class="peek">${r.from ? `<s>${esc(r.from)}</s>` : ''}${r.to ? `<ins>${esc(r.to)}</ins>` : ''}</div></li>`;
    }
    if (r.kind === 'list') {
        const n = r.d.changed.length + r.d.added.length + r.d.removed.length;
        return `<li><b>${esc(r.label)}</b><span class="n">항목 ${n}개 다름 · ${esc(r.total)}</span>
            <div class="peek">${listLine(r.d.changed, '✏️')}${listLine(r.d.added, '+')}${listLine(r.d.removed, '−')}</div></li>`;
    }
    return `<li class="${r.kind === 'note' ? 'note' : ''}"><b>${esc(r.label)}</b><span class="n">${esc(r.text)}</span></li>`;
}

function groupHtml(g) {
    const tw = state.twins;
    const res = tw.results[g.key];
    const open = tw.open.has(g.key);
    const others = g.members.filter((a) => a !== res.base);
    const same = others.filter((a) => !res.broken[a] && countDiffs(res.rows[a]) === 0).length;
    const pcts = others.map((a) => res.why[a]?.pct ?? 0);
    const range = pcts.length ? (Math.min(...pcts) === Math.max(...pcts) ? `${pcts[0]}%` : `${Math.min(...pcts)}~${Math.max(...pcts)}%`) : '';
    const summary = same === others.length
        ? `<span class="kts-tag tw-same">🟰 복제본${others.length > 1 ? ` ${others.length}개` : ''}</span>`
        : `<span class="kts-tag tw-diff">✏️ 수정본 · 내용 ${range} 같음</span>${same ? `<span class="kts-tag tw-same">🟰 복제본 ${same}개</span>` : ''}`;
    const head = `<header data-act="tw-toggle" data-key="${esc(g.key)}">
        <div class="avs">${g.members.slice(0, 4).map((a) => `<img src="${esc(avatarUrl(a))}" alt="" loading="lazy">`).join('')}</div>
        <div class="info"><b>${esc(cut(g.name, 28))}</b><small>${g.members.length}개 카드 · 📍 ${esc(cut(tw.cards.get(res.base)?.name || '', 16))} 기준${others.some((a) => res.broken[a]) ? ' · ⚠️ 못 읽은 카드 있음' : ''}</small></div>
        <div class="sum">${summary}</div><span class="chev">${open ? '▾' : '▸'}</span></header>`;
    if (!open) return `<section class="tw-grp">${head}</section>`;

    const cards = g.members.map((a) => {
        const c = tw.cards.get(a) || {};
        const isBase = a === res.base;
        const rows = isBase ? null : res.rows[a];
        const n = rows ? countDiffs(rows) : 0;
        const why = isBase ? '' : simText(res.why[a]);
        const verdict = isBase ? '<span class="kts-tag tw-base">📍 기준</span>'
            : res.broken[a] ? '<span class="kts-tag tw-diff">⚠️ 카드 내용을 못 읽었어요</span>'
            : n === 0 ? `<span class="kts-tag tw-same">🟰 ${res.full ? '완전 똑같음' : '똑같아 보임'}${rows.some((r) => r.label === '이름') ? ' (이름만 다름)' : ''}</span>`
                : `<span class="kts-tag tw-diff">✏️ ${n}곳 다름</span>`;
        const on = tw.sel.has(a);
        return `<div class="tw-card ${isBase ? 'base' : ''} ${on ? 'picked' : ''}">
            <div class="top"><button class="kts-ck ${on ? 'on' : ''}" data-act="tw-pick" data-avatar="${esc(a)}" title="삭제할 캐릭터로 고르기">${on ? '✓' : ''}</button><img src="${esc(avatarUrl(a))}" alt="" loading="lazy">
                <div class="info"><b>${esc(cut(c.name || a, 26))}</b><small>${esc(memberMeta(a))}</small><small class="file">${esc(cut(a, 40))}</small>${why ? `<small class="why">📊 기준과 ${esc(why)}</small>` : ''}</div>
                ${verdict}</div>
            ${rows && rows.length ? `<ul>${rows.map(rowHtml).join('')}</ul>` : ''}
            <div class="btns">${isBase ? '' : `<button class="kts-b" data-act="tw-base" data-key="${esc(g.key)}" data-avatar="${esc(a)}">📍 기준으로</button>`}
                <button class="kts-b" data-act="hub-map" data-avatar="${esc(a)}">🗺️ 노선도</button></div>
        </div>`;
    }).join('');
    return `<section class="tw-grp open">${head}
        <div class="tw-tools">${same ? `<button class="kts-b" data-act="tw-pick-same" data-key="${esc(g.key)}">🟰 똑같은 복제본만 고르기</button>` : ''}<small>지울 캐릭터를 ☐ 체크하면 아래에 삭제 버튼이 나와요.</small></div>
        ${res.pending ? '<div class="tw-wait">월드인포와 이미지까지 비교하는 중…</div>' : ''}
        <div class="tw-cards">${cards}</div></section>`;
}

export function twinsHtml() {
    const tw = state.twins;
    if (!tw?.groups) {
        if (!tw?.loading) setTimeout(() => scanTwins(), 0);
        const p = tw?.total ? ` (${tw.done}/${tw.total})` : '';
        return `<div class="kts-empty">중복 승차권을 검표하는 중…${p} 🎫</div>`;
    }
    const q = normName(tw.query);
    const hit = (avs) => !q || avs.some((a) => normName(tw.cards.get(a)?.name).includes(q));
    const nCopy = tw.groups.filter((g) => kindOf(g) === 'copy').length;
    const nEdit = tw.groups.length - nCopy;
    const nName = (tw.nameOnly || []).length;
    const f = tw.filter || 'all';
    const groups = f === 'name' ? [] : tw.groups.filter((g) => hit(g.members) && (f === 'all' || kindOf(g) === f));
    const chip = (k, label) => `<button class="kts-pill ${f === k ? 'on' : ''}" data-act="tw-filter" data-v="${k}">${label}</button>`;
    const toolbar = `<div class="kts-toolbar">
        <span class="kts-cur">🎫 중복 검표<small>${tw.groups.length}묶음</small></span>
        <input id="kts-tw-search" class="kts-search" placeholder="캐릭터 이름으로 찾기" value="${esc(tw.query)}">
        <button class="kts-pill" data-act="tw-rescan" ${tw.loading ? 'disabled' : ''}>${tw.loading ? `검사 중 ${tw.done}/${tw.total}` : '↻ 다시 검사'}</button>
    </div>
    <div class="kts-toolbar tw-filters">${chip('all', `전체 ${tw.groups.length}`)}${chip('copy', `🟰 복제본 ${nCopy}`)}${chip('edit', `✏️ 수정본 ${nEdit}`)}${nName ? chip('name', `🔤 이름만 같음 ${nName}`) : ''}</div>
    <div class="tw-hint">${f === 'name'
        ? '이름은 같지만 내용이 거의 겹치지 않아서 <b>다른 봇</b>으로 본 캐릭터들이에요. 비교 목록에는 넣지 않았어요.'
        : '카드 본문(설명·성격·시나리오·첫 메시지 등)이 실제로 얼마나 겹치는지로 묶었어요. 여러 봇이 같이 쓰는 템플릿 문장은 빼고 세요. <b>🟰 복제본</b>은 전부 똑같은 카드, <b>✏️ 수정본</b>은 고친 버전이에요.'}</div>`;
    if (f === 'name') {
        const rows = (tw.nameOnly || []).filter(hit).map((avs) => `<section class="tw-grp tw-nameonly"><header>
            <div class="avs">${avs.slice(0, 4).map((a) => `<img src="${esc(avatarUrl(a))}" alt="" loading="lazy">`).join('')}</div>
            <div class="info"><b>${esc(cut(tw.cards.get(avs[0])?.name || '', 28))}</b><small>${avs.map((a) => esc(cut(tw.cards.get(a)?.name || a, 18))).join(' · ')}</small></div>
            <div class="sum"><span class="kts-tag tw-base">내용 ${similarityPct(avs)} 같음</span></div></header></section>`).join('');
        return toolbar + `<div class="tw-list">${rows || '<div class="kts-empty">없어요.</div>'}</div>`;
    }
    if (!tw.groups.length) return toolbar + '<div class="kts-empty">중복된 승차권이 없어요. 깔끔하네요! ✨</div>';
    for (const a of [...tw.sel]) if (!tw.cards.has(a)) tw.sel.delete(a);
    const foot = tw.sel.size ? `<div class="kts-foot"><span>🗑️ 캐릭터 ${tw.sel.size}명 골랐어요</span>
        <button class="kts-b" data-act="tw-pick-clear">선택 해제</button>
        <button class="kts-b d" data-act="tw-delete" ${tw.deleting ? 'disabled' : ''}>${tw.deleting ? '삭제 중…' : '🗑️ 삭제'}</button></div>` : '';
    return toolbar + `<div class="tw-list">${groups.map(groupHtml).join('') || '<div class="kts-empty">찾는 이름이 없어요.</div>'}</div>` + foot;
}

// ---------------------------------------------------------------- events

export async function twinsClick(act, el) {
    const tw = state.twins;
    switch (act) {
        case 'tw-rescan': worldCache.clear(); imgCache.clear(); await scanTwins(true); return true;
        case 'tw-toggle': {
            const key = el.dataset.key;
            if (tw.open.has(key)) tw.open.delete(key);
            else {
                tw.open.add(key);
                const g = tw.groups.find((x) => x.key === key);
                if (g && !tw.results[key].full && !tw.results[key].pending) computeGroup(g);
            }
            app.render();
            return true;
        }
        case 'tw-pick': {
            const a = el.dataset.avatar;
            if (tw.sel.has(a)) tw.sel.delete(a); else tw.sel.add(a);
            app.render();
            return true;
        }
        case 'tw-pick-same': {
            const res = tw.results[el.dataset.key];
            for (const [a, rows] of Object.entries(res?.rows || {})) if (!res.broken[a] && countDiffs(rows) === 0) tw.sel.add(a);
            app.render();
            return true;
        }
        case 'tw-pick-clear': tw.sel.clear(); app.render(); return true;
        case 'tw-filter': tw.filter = el.dataset.v; app.render(); return true;
        case 'tw-delete': if (!tw.deleting) await deleteSelected(); return true;
        case 'tw-base': {
            tw.base[el.dataset.key] = el.dataset.avatar;
            const g = tw.groups.find((x) => x.key === el.dataset.key);
            if (g) computeGroup(g);
            app.render();
            return true;
        }
    }
    return false;
}

export function twinsInput(ev) {
    if (ev.target.id !== 'kts-tw-search' || !state.twins) return false;
    state.twins.query = ev.target.value;
    app.render();
    return true;
}

// ---------------------------------------------------------------- deleting picked characters

async function deleteSelected() {
    const tw = state.twins;
    const avatars = [...tw.sel].filter((a) => charByAvatar(a));
    if (!avatars.length) return;
    const c = ctx();
    const wholeGroup = tw.groups.filter((g) => g.members.every((a) => tw.sel.has(a)));
    const list = avatars.map((a) => `<li><b>${esc(cut(tw.cards.get(a)?.name || a, 30))}</b> <small>${esc(memberMeta(a))}</small></li>`).join('');
    const warn = wholeGroup.length ? `<p class="warn">⚠️ ${wholeGroup.map((g) => esc(cut(g.name, 16))).join(', ')} 묶음은 <b>전부</b> 골랐어요. 하나도 안 남아요!</p>` : '';
    const html = `<div class="kts-pop-list"><p>캐릭터 카드 <b>${avatars.length}개</b>를 삭제해요. 되돌릴 수 없어요.</p><ul>${list}</ul>${warn}
        <p><small>지금 열려 있는 챗은 닫혀요. 챗 파일을 남기면 나중에 같은 이름의 카드를 다시 불러와도 안 이어질 수 있어요.</small></p></div>`;
    const popup = new c.Popup(html, c.POPUP_TYPE.CONFIRM, '', {
        okButton: '삭제',
        cancelButton: '취소',
        customInputs: [{ id: 'kts_tw_chats', label: '이 캐릭터들의 챗 파일도 같이 지우기', defaultState: false }],
    });
    const result = await popup.show();
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const deleteChats = !!popup.inputResults?.get('kts_tw_chats');

    tw.deleting = true;
    app.render();
    try {
        let done = false;
        try {
            const st = await import('/script.js');
            if (typeof st.deleteCharacter === 'function') { await st.deleteCharacter(avatars, { deleteChats }); done = true; }
        } catch (err) { console.warn(LOG, 'deleteCharacter import failed, using the API', err); }
        if (!done) {
            for (const a of avatars) await fetch('/api/characters/delete', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: a, delete_chats: deleteChats }) });
            await c.getCharacters?.();
        }
        const gone = avatars.filter((a) => !charByAvatar(a));
        const s = getSettings();
        for (const a of gone) { tw.sel.delete(a); tw.cards.delete(a); if (s.chats) delete s.chats[a]; }
        save();
        for (const g of tw.groups) g.members = g.members.filter((a) => tw.cards.has(a));
        tw.groups = tw.groups.filter((g) => g.members.length > 1);
        for (const g of tw.groups) computeGroup(g, !tw.open.has(g.key));
        state.hub = null;
        if (gone.includes(state.avatar)) { state.avatar = null; state.list = []; state.mapStale = true; }
        toastr.success(`캐릭터 ${gone.length}개를 지웠어요.${gone.length < avatars.length ? ` (${avatars.length - gone.length}개 실패)` : ''}`, TOAST);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('삭제하다가 문제가 생겼어요.', TOAST);
    }
    tw.deleting = false;
    app.render();
}
