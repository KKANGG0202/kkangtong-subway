// 깡통 노선도 - chat downloads: one station as .jsonl, or a whole bot as a .zip backup

import { LOG, TOAST, state, ctx, getSettings, charByAvatar, linesFor } from './core.js';

// ---------------------------------------------------------------- helpers

const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+$/, '').slice(0, 150) || 'chat';

async function rawChat(id, avatar) {
    const res = await fetch('/api/chats/get', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ file_name: id, avatar_url: avatar, ch_name: charByAvatar(avatar)?.char?.name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('empty chat');
    // ST writes one JSON object per line, header first — same as here, so the file re-imports as is
    return data.map((x) => JSON.stringify(x)).join('\n');
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60e3);
}

// ---------------------------------------------------------------- tiny ZIP writer (stored, no compression)

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/** @param {{name: string, text: string}[]} files */
export function makeZip(files) {
    const enc = new TextEncoder();
    const { time, date } = dosTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    const used = new Set();
    for (const f of files) {
        let name = f.name;
        for (let i = 2; used.has(name); i++) name = f.name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
        used.add(name);
        const nameBytes = enc.encode(name);
        const data = enc.encode(f.text);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8 file names (Korean titles)
        local.setUint16(8, 0, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        parts.push(local, nameBytes, data);

        const cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true);
        cen.setUint16(4, 20, true);
        cen.setUint16(6, 20, true);
        cen.setUint16(8, 0x0800, true);
        cen.setUint16(10, 0, true);
        cen.setUint16(12, time, true);
        cen.setUint16(14, date, true);
        cen.setUint32(16, crc, true);
        cen.setUint32(20, data.length, true);
        cen.setUint32(24, data.length, true);
        cen.setUint16(28, nameBytes.length, true);
        cen.setUint32(42, offset, true);
        central.push(cen, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ---------------------------------------------------------------- actions

export async function downloadOne(id, avatar = state.avatar) {
    try {
        const text = await rawChat(id, avatar);
        saveBlob(new Blob([text], { type: 'application/jsonl' }), `${safeName(id)}.jsonl`);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('챗 파일을 받지 못했어요.', TOAST);
    }
}

/** Every station of the bot, plus our titles/summaries/lines so nothing written here is lost. */
export async function downloadBot(avatar = state.avatar, onProgress = () => {}) {
    const ids = state.avatar === avatar ? state.list.map((c) => c.id) : [];
    if (!ids.length) { toastr.info('받을 역이 없어요.', TOAST); return; }
    const files = [];
    const failed = [];
    let done = 0;
    for (const id of ids) {
        try { files.push({ name: `chats/${safeName(id)}.jsonl`, text: await rawChat(id, avatar) }); } catch (err) { console.warn(LOG, id, err); failed.push(id); }
        onProgress(++done, ids.length);
    }
    const char = charByAvatar(avatar)?.char;
    const notes = {
        kind: 'kkangtong-subway-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        character: { name: char?.name || '', avatar },
        lines: linesFor(avatar),
        stations: getSettings().chats?.[avatar] || {},
    };
    files.push({ name: '깡통노선도_제목과요약.json', text: JSON.stringify(notes, null, 2) });
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(makeZip(files), `${safeName(char?.name || avatar)}_노선도백업_${stamp}.zip`);
    if (failed.length) toastr.warning(`${failed.length}개 역은 못 받았어요.`, TOAST);
    else toastr.success(`역 ${ids.length}개를 zip 하나로 저장했어요.`, TOAST);
}
