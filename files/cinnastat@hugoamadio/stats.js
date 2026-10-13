// Pure helpers for reading /proc and formatting numbers. Nothing here touches
// Cinnamon or GLib, so `node test/stats.test.js` can exercise all of it.

const KIB = 1024;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// one /proc/stat cpu line -> { busy, total } in jiffies since boot
function cpuTimes(line) {
    // user nice system idle iowait irq softirq steal (guest time is already counted in user)
    const f = line.trim().split(/\s+/).slice(1, 9).map((n) => Number(n) || 0);
    const total = f.reduce((a, b) => a + b, 0);
    const idle = (f[3] || 0) + (f[4] || 0);
    return { busy: total - idle, total };
}

// /proc/stat -> all cores together
function parseCpu(text) {
    const line = String(text).split("\n", 1)[0];
    return /^cpu\s/.test(line) ? cpuTimes(line) : { busy: 0, total: 0 };
}

// /proc/stat -> one reading per core (cpu0, cpu1, ...)
function parseCores(text) {
    const cores = [];
    for (const line of String(text).split("\n")) if (/^cpu\d+\s/.test(line)) cores.push(cpuTimes(line));
    return cores;
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

// /proc/diskstats -> { name: { read, written, busyMs } } for the disks accept(name) keeps.
// read/written are bytes (sectors here are always 512 bytes, whatever the disk uses);
// busyMs is the time the disk had I/O in flight, the same counter iostat's %util uses.
function parseDisks(text, accept) {
    const disks = {};
    for (const line of String(text).split("\n")) {
        const f = line.trim().split(/\s+/);
        if (f.length < 13 || !accept(f[2])) continue;
        disks[f[2]] = {
            read: (Number(f[5]) || 0) * 512,
            written: (Number(f[9]) || 0) * 512,
            busyMs: Number(f[12]) || 0,
        };
    }
    return disks;
}

// /proc/net/dev -> { name: { rx, tx } } in bytes, for the interfaces accept(name) keeps
function parseNet(text, accept) {
    const ifaces = {};
    for (const line of String(text).split("\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const f = line.slice(i + 1).trim().split(/\s+/);
        if (f.length < 9 || !accept(name)) continue;
        ifaces[name] = { rx: Number(f[0]) || 0, tx: Number(f[8]) || 0 };
    }
    return ifaces;
}

// sum of one field over parseDisks()/parseNet() entries
function total(map, field) {
    let sum = 0;
    for (const name in map) sum += map[name][field];
    return sum;
}

// how busy the busiest disk was over the interval, 0..100
function diskBusy(prev, cur, seconds) {
    if (!prev || !cur || !(seconds > 0)) return 0;
    let max = 0;
    for (const name in cur) {
        if (!prev[name]) continue;
        const ms = cur[name].busyMs - prev[name].busyMs;
        if (ms > 0) max = Math.max(max, (100 * ms) / (seconds * 1000));
    }
    return clamp(max, 0, 100);
}

// how much of its speed the busiest link used, 0..100, or null when no speed is known.
// links: { name: { bps, wireless } }. Cable is full duplex, so the busier direction
// counts; Wi-Fi shares the air, so download and upload add up.
function netBusy(prev, cur, seconds, links) {
    if (!prev || !cur || !(seconds > 0)) return null;
    let max = null;
    for (const name in links) {
        const a = prev[name];
        const b = cur[name];
        const link = links[name];
        if (!a || !b || !link || !(link.bps > 0)) continue;
        const rx = rate(a.rx, b.rx, seconds);
        const tx = rate(a.tx, b.tx, seconds);
        const bytes = link.wireless ? rx + tx : Math.max(rx, tx);
        max = Math.max(max || 0, (100 * bytes * 8) / link.bps);
    }
    return max === null ? null : clamp(max, 0, 100);
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

// memory in use over the total, sized for a cell: "18/31G", "3.2/7.7G", "700/980M"
function usedOf(used, all) {
    const big = all >= KIB ** 3;
    const div = big ? KIB ** 3 : KIB ** 2;
    const whole = !big || all / div >= 10;
    const fmt = (v) => (whole ? String(Math.round(v / div)) : (v / div).toFixed(1));
    return fmt(Math.max(0, Number(used) || 0)) + "/" + fmt(Math.max(0, Number(all) || 0)) + (big ? "G" : "M");
}

// link speed for the tooltip: "1 Gbit/s", "2.5 Gbit/s", "97.6 Mbit/s", "300 Mbit/s"
function bitrate(bps) {
    if (bps >= 1e9) return String(Number((bps / 1e9).toFixed(1))) + " Gbit/s";
    const m = bps / 1e6;
    return (m >= 100 ? String(Math.round(m)) : String(Number(m.toFixed(1)))) + " Mbit/s";
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
    parseCores,
    cpuPercent,
    parseMem,
    parseDisks,
    parseNet,
    total,
    diskBusy,
    netBusy,
    parseLoad,
    rate,
    compact,
    human,
    percent,
    usedOf,
    bitrate,
    push,
    scaleMax,
    parseColor,
};
