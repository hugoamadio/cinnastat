// Pure helpers for reading /proc and formatting numbers. Nothing here touches
// Cinnamon or GLib, so `node test/stats.test.js` can exercise all of it.

const KIB = 1024;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// /proc/stat, first line -> { busy, total } in jiffies since boot
function parseCpu(text) {
    const line = String(text).split("\n", 1)[0];
    if (!/^cpu\s/.test(line)) return { busy: 0, total: 0 };
    // user nice system idle iowait irq softirq steal (guest time is already counted in user)
    const f = line.trim().split(/\s+/).slice(1, 9).map((n) => Number(n) || 0);
    const total = f.reduce((a, b) => a + b, 0);
    const idle = (f[3] || 0) + (f[4] || 0);
    return { busy: total - idle, total };
}

// two parseCpu() readings -> busy percentage over the interval between them
function cpuPercent(prev, cur) {
    if (!prev || !cur) return 0;
    const dt = cur.total - prev.total;
    if (dt <= 0) return 0;
    return clamp((100 * (cur.busy - prev.busy)) / dt, 0, 100);
}

// /proc/meminfo -> bytes; "used" is what the kernel cannot hand out right now
function parseMem(text) {
    const kb = {};
    for (const line of String(text).split("\n")) {
        const m = /^(\w+):\s+(\d+)/.exec(line);
        if (m) kb[m[1]] = Number(m[2]) * KIB;
    }
    const total = kb.MemTotal || 0;
    const available = kb.MemAvailable !== undefined
        ? kb.MemAvailable
        : (kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0);
    const swapTotal = kb.SwapTotal || 0;
    return {
        total,
        used: clamp(total - available, 0, total),
        swapTotal,
        swapUsed: clamp(swapTotal - (kb.SwapFree || 0), 0, swapTotal),
    };
}

// /proc/diskstats -> bytes read and written since boot by the disks accept(name) keeps.
// Sectors here are always 512 bytes, whatever the disk's real sector size.
function parseDisks(text, accept) {
    let read = 0;
    let written = 0;
    for (const line of String(text).split("\n")) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !accept(f[2])) continue;
        read += (Number(f[5]) || 0) * 512;
        written += (Number(f[9]) || 0) * 512;
    }
    return { read, written };
}

// /proc/net/dev -> bytes received and sent since boot by the interfaces accept(name) keeps
function parseNet(text, accept) {
    let rx = 0;
    let tx = 0;
    for (const line of String(text).split("\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const f = line.slice(i + 1).trim().split(/\s+/);
        if (f.length < 9 || !accept(name)) continue;
        rx += Number(f[0]) || 0;
        tx += Number(f[8]) || 0;
    }
    return { rx, tx };
}

// /proc/loadavg -> "1.20 0.95 0.80"
function parseLoad(text) {
    return String(text).trim().split(/\s+/).slice(0, 3).join(" ");
}

// bytes/second between two counter readings; a counter that went back (device
// unplugged, interface recreated) counts as no traffic instead of a negative spike
function rate(prev, cur, seconds) {
    if (prev === null || prev === undefined || !(seconds > 0) || cur < prev) return 0;
    return (cur - prev) / seconds;
}

// fits a panel cell: 0B 812B 1.5K 52K 1.2M 340M 2.1G
function compact(bytes) {
    const units = ["B", "K", "M", "G", "T"];
    let v = Math.max(0, Number(bytes) || 0);
    let u = 0;
    while (v >= 999.5 && u < units.length - 1) {
        v /= KIB;
        u++;
    }
    const n = u > 0 && v < 9.95 ? v.toFixed(1) : String(Math.round(v));
    return n + units[u];
}

// for the tooltip: "812 B", "1.5 KB", "15.4 GB"
function human(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Math.max(0, Number(bytes) || 0);
    let u = 0;
    while (v >= 999.5 && u < units.length - 1) {
        v /= KIB;
        u++;
    }
    return (u > 0 && v < 99.95 ? v.toFixed(1) : String(Math.round(v))) + " " + units[u];
}

function percent(v) {
    return Math.round(clamp(Number(v) || 0, 0, 100)) + "%";
}

// keeps the newest `size` samples
function push(history, value, size) {
    history.push(value);
    if (history.length > size) history.splice(0, history.length - size);
    return history;
}

// top of the graph for a rate: the busiest visible sample, never below `floor`
// so idle background noise stays a thin line instead of filling the cell
function scaleMax(values, floor) {
    let max = floor;
    for (const v of values) if (v > max) max = v;
    return max;
}

// "#4ea1ff", "rgb(78,161,255)" or "rgba(78,161,255,0.5)" -> { r, g, b, a } in 0..1
function parseColor(text, fallback) {
    const s = String(text || "").trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) {
        return {
            r: clamp(Number(m[1]) / 255, 0, 1),
            g: clamp(Number(m[2]) / 255, 0, 1),
            b: clamp(Number(m[3]) / 255, 0, 1),
            a: m[4] === undefined ? 1 : clamp(Number(m[4]), 0, 1),
        };
    }
    return fallback === undefined ? { r: 1, g: 1, b: 1, a: 1 } : fallback;
}

module.exports = {
    clamp,
    parseCpu,
    cpuPercent,
    parseMem,
    parseDisks,
    parseNet,
    parseLoad,
    rate,
    compact,
    human,
    percent,
    push,
    scaleMax,
    parseColor,
};
