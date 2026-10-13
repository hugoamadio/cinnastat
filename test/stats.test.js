// node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../files/cinnastat@hugoamadio/stats.js");

const all = () => true;

test("parseCpu sums the first 8 fields and counts idle + iowait as idle", () => {
    const stat = "cpu  100 5 50 800 20 3 2 1 40 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1\n";
    assert.deepEqual(S.parseCpu(stat), { busy: 161, total: 981 });
});

test("parseCpu survives short, empty and foreign input", () => {
    assert.deepEqual(S.parseCpu(""), { busy: 0, total: 0 });
    assert.deepEqual(S.parseCpu("intr 1 2 3"), { busy: 0, total: 0 });
    assert.deepEqual(S.parseCpu("cpu 10 0 10 80"), { busy: 20, total: 100 });
    assert.deepEqual(S.parseCpu(undefined), { busy: 0, total: 0 });
});

test("parseCores returns one reading per core and ignores the total line", () => {
    const stat = "cpu  9 9 9 9\ncpu0 10 0 10 80\ncpu1 50 0 0 50\nintr 1\n";
    assert.deepEqual(S.parseCores(stat), [{ busy: 20, total: 100 }, { busy: 50, total: 100 }]);
    assert.deepEqual(S.parseCores(""), []);
});

test("cpuPercent compares two readings and stays within 0..100", () => {
    assert.equal(S.cpuPercent({ busy: 100, total: 1000 }, { busy: 150, total: 1100 }), 50);
    assert.equal(S.cpuPercent(null, { busy: 1, total: 2 }), 0);
    assert.equal(S.cpuPercent({ busy: 5, total: 10 }, { busy: 5, total: 10 }), 0); // no time passed
    assert.equal(S.cpuPercent({ busy: 50, total: 100 }, { busy: 10, total: 50 }), 0); // counters went back
    assert.equal(S.cpuPercent({ busy: 0, total: 100 }, { busy: 500, total: 200 }), 100); // absurd jump is capped
});

test("parseMem uses MemAvailable and reports swap", () => {
    const meminfo = [
        "MemTotal:       16000000 kB",
        "MemFree:         1000000 kB",
        "MemAvailable:    6000000 kB",
        "Buffers:          200000 kB",
        "Cached:          3000000 kB",
        "SwapTotal:       2000000 kB",
        "SwapFree:        1500000 kB",
        "Hugepagesize:       2048 kB",
    ].join("\n");
    assert.deepEqual(S.parseMem(meminfo), {
        total: 16000000 * 1024,
        used: 10000000 * 1024,
        swapTotal: 2000000 * 1024,
        swapUsed: 500000 * 1024,
    });
});

test("parseMem falls back to free + buffers + cached on old kernels and handles no swap", () => {
    const m = S.parseMem("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n");
    assert.equal(m.used, 600 * 1024);
    assert.equal(m.swapTotal, 0);
    assert.equal(m.swapUsed, 0);
    assert.deepEqual(S.parseMem(""), { total: 0, used: 0, swapTotal: 0, swapUsed: 0 });
});

const DISKSTATS = `
 259       0 nvme0n1 1000 0 2000 0 500 0 4000 0 0 700 900 0 0 0 0 0 0
 259       1 nvme0n1p1 10 0 20 0 5 0 40 0 0 10 10
   7       0 loop0 99 0 9999 0 0 0 0 0 0 0 0
 253       0 dm-0 900 0 1800 0 450 0 3600 0 0 600 800
   8       0 sda 1 0 8 0 1 0 16 0 0 5 5
`;

test("parseDisks keeps whole physical disks only: bytes and busy time", () => {
    const physical = (n) => n === "nvme0n1" || n === "sda";
    const disks = S.parseDisks(DISKSTATS, physical);
    assert.deepEqual(disks, {
        nvme0n1: { read: 2000 * 512, written: 4000 * 512, busyMs: 700 },
        sda: { read: 8 * 512, written: 16 * 512, busyMs: 5 },
    });
    assert.equal(S.total(disks, "read"), (2000 + 8) * 512);
    assert.equal(S.total(disks, "written"), (4000 + 16) * 512);
    assert.deepEqual(S.parseDisks("", physical), {});
    assert.deepEqual(S.parseDisks("garbage line\n1 2\n 8 0 sdb 1 0 8 0 1 0 16\n", all), {}); // too few fields
});

test("diskBusy is the busiest disk's share of the interval", () => {
    const a = { nvme0n1: { busyMs: 1000 }, sda: { busyMs: 0 } };
    const b = { nvme0n1: { busyMs: 1250 }, sda: { busyMs: 900 } };
    assert.equal(S.diskBusy(a, b, 1), 90); // sda busy 900 of 1000 ms
    assert.equal(S.diskBusy(a, b, 2), 45);
    assert.equal(S.diskBusy(a, { nvme0n1: { busyMs: 9999 } }, 1), 100); // capped
    assert.equal(S.diskBusy(a, { usb: { busyMs: 500 } }, 1), 0); // disk just plugged in: no baseline yet
    assert.equal(S.diskBusy(a, { nvme0n1: { busyMs: 10 } }, 1), 0); // counter went back
    assert.equal(S.diskBusy(null, b, 1), 0);
    assert.equal(S.diskBusy(a, b, 0), 0);
});

const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
wlp0s20f3: 123456 100 0 0 0 0 0 0 7890 50 0 0 0 0 0 0
docker0:    999      1    0    0    0     0          0         0      999       1    0    0    0     0       0          0
enp3s0:1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
`;

test("parseNet keeps the interfaces asked for, even when the name touches the colon", () => {
    const physical = (n) => n === "wlp0s20f3" || n === "enp3s0";
    const net = S.parseNet(NETDEV, physical);
    assert.deepEqual(net, { wlp0s20f3: { rx: 123456, tx: 7890 }, enp3s0: { rx: 1000, tx: 2000 } });
    assert.equal(S.total(net, "rx"), 124456);
    assert.equal(S.total(net, "tx"), 9890);
    assert.deepEqual(S.parseNet(NETDEV, () => false), {});
    assert.deepEqual(S.parseNet("", all), {});
    assert.equal(S.total({}, "rx"), 0);
});

test("netBusy compares traffic with the link speed of each interface", () => {
    const MB = 1e6 / 8; // bytes per second in 1 Mbit/s
    const a = { eth: { rx: 0, tx: 0 }, wifi: { rx: 0, tx: 0 } };
    const b = { eth: { rx: 500 * MB, tx: 100 * MB }, wifi: { rx: 30 * MB, tx: 30 * MB } };
    const cable = { eth: { bps: 1e9, wireless: false } };
    const air = { wifi: { bps: 100e6, wireless: true } };
    assert.equal(S.netBusy(a, b, 1, cable), 50); // cable: busier direction, 500 of 1000 Mbit/s
    assert.equal(S.netBusy(a, b, 1, air), 60); // Wi-Fi: both directions share 100 Mbit/s
    assert.equal(S.netBusy(a, b, 1, { ...cable, ...air }), 60); // the busiest link wins
    assert.equal(S.netBusy(a, b, 2, cable), 25);
    assert.equal(S.netBusy(a, { eth: { rx: 5000 * MB, tx: 0 } }, 1, cable), 100); // capped
    assert.equal(S.netBusy(a, b, 1, {}), null); // no speed known
    assert.equal(S.netBusy(a, b, 1, { eth: { bps: 0 } }), null);
    assert.equal(S.netBusy(a, b, 1, { usb0: { bps: 1e9 } }), null); // speed for an interface with no traffic data
    assert.equal(S.netBusy(null, b, 1, cable), null);
    assert.equal(S.netBusy(a, { eth: { rx: 0, tx: 0 } }, 1, cable), 0);
});

test("parseLoad keeps the three averages", () => {
    assert.equal(S.parseLoad("1.20 0.95 0.80 2/1234 5678\n"), "1.20 0.95 0.80");
    assert.equal(S.parseLoad(""), "");
});

test("rate is bytes per second and never negative", () => {
    assert.equal(S.rate(1000, 3000, 2), 1000);
    assert.equal(S.rate(undefined, 3000, 2), 0);
    assert.equal(S.rate(null, 3000, 2), 0);
    assert.equal(S.rate(0, 3000, 2), 1500); // a counter at zero is a real reading
    assert.equal(S.rate(5000, 100, 1), 0); // counter reset
    assert.equal(S.rate(1, 2, 0), 0);
    assert.equal(S.rate(1, 2, NaN), 0);
});

test("compact fits a panel cell", () => {
    const cases = [
        [0, "0B"], [-5, "0B"], [NaN, "0B"], [812, "812B"], [999, "999B"], [1000, "1.0K"],
        [1536, "1.5K"], [10189, "10K"], [52000, "51K"], [1023487, "999K"], [1023999, "1.0M"],
        [1.2 * 1024 * 1024, "1.2M"], [340 * 1024 * 1024, "340M"], [2.1 * 1024 ** 3, "2.1G"],
        [5 * 1024 ** 5, "5120T"],
    ];
    for (const [bytes, want] of cases) assert.equal(S.compact(bytes), want, `compact(${bytes})`);
    for (let b = 1; b < 1e12; b *= 1.37) assert.ok(S.compact(b).length <= 4, `compact(${b}) = ${S.compact(b)}`);
});

test("human reads well in the tooltip", () => {
    assert.equal(S.human(0), "0 B");
    assert.equal(S.human(812), "812 B");
    assert.equal(S.human(1536), "1.5 KB");
    assert.equal(S.human(16 * 1024 ** 3), "16.0 GB");
    assert.equal(S.human(468 * 1024 ** 3), "468 GB");
});

test("usedOf fits memory in a cell", () => {
    const G = 1024 ** 3;
    const M = 1024 ** 2;
    assert.equal(S.usedOf(18.4 * G, 31.1 * G), "18/31G");
    assert.equal(S.usedOf(0.4 * G, 31.1 * G), "0/31G");
    assert.equal(S.usedOf(3.24 * G, 7.7 * G), "3.2/7.7G");
    assert.equal(S.usedOf(700 * M, 980 * M), "700/980M");
    assert.equal(S.usedOf(0, 0), "0/0M");
    assert.equal(S.usedOf(-1, 16 * G), "0/16G");
});

test("bitrate reads like a network speed", () => {
    assert.equal(S.bitrate(1e9), "1 Gbit/s");
    assert.equal(S.bitrate(2.5e9), "2.5 Gbit/s");
    assert.equal(S.bitrate(97.6e6), "97.6 Mbit/s");
    assert.equal(S.bitrate(58.5e6), "58.5 Mbit/s");
    assert.equal(S.bitrate(100e6), "100 Mbit/s");
    assert.equal(S.bitrate(866.7e6), "867 Mbit/s");
    assert.equal(S.bitrate(10e6), "10 Mbit/s");
});

test("percent rounds and clamps", () => {
    assert.equal(S.percent(23.4), "23%");
    assert.equal(S.percent(99.6), "100%");
    assert.equal(S.percent(-3), "0%");
    assert.equal(S.percent(250), "100%");
    assert.equal(S.percent(undefined), "0%");
});

test("push keeps the newest samples", () => {
    const h = [];
    for (let i = 1; i <= 10; i++) S.push(h, i, 3);
    assert.deepEqual(h, [8, 9, 10]);
});

test("scaleMax never goes below the floor", () => {
    assert.equal(S.scaleMax([], 100), 100);
    assert.equal(S.scaleMax([5, 20, 3], 100), 100);
    assert.equal(S.scaleMax([5, 250, 3], 100), 250);
});

test("parseColor understands what the Cinnamon color chooser saves", () => {
    assert.deepEqual(S.parseColor("rgb(255,0,51)"), { r: 1, g: 0, b: 0.2, a: 1 });
    assert.deepEqual(S.parseColor("rgba(255, 255, 0, 0.5)"), { r: 1, g: 1, b: 0, a: 0.5 });
    assert.deepEqual(S.parseColor("#ff0033"), { r: 1, g: 0, b: 0.2, a: 1 });
    assert.deepEqual(S.parseColor("rgb(999,0,0)"), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(S.parseColor("tomato"), { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(S.parseColor(undefined, null), null);
});

test("the parsers read this machine's /proc without throwing", { skip: process.platform !== "linux" }, () => {
    const fs = require("node:fs");
    const cpu = S.parseCpu(fs.readFileSync("/proc/stat", "utf8"));
    assert.ok(cpu.total > 0 && cpu.busy >= 0 && cpu.busy <= cpu.total);
    const mem = S.parseMem(fs.readFileSync("/proc/meminfo", "utf8"));
    assert.ok(mem.total > 0 && mem.used > 0 && mem.used <= mem.total);
    assert.ok(S.parseCores(fs.readFileSync("/proc/stat", "utf8")).length >= 1);
    const disks = S.parseDisks(fs.readFileSync("/proc/diskstats", "utf8"), (n) => fs.existsSync(`/sys/block/${n}/device`));
    for (const d of Object.values(disks)) assert.ok(d.read >= 0 && d.written >= 0 && d.busyMs >= 0);
    const net = S.parseNet(fs.readFileSync("/proc/net/dev", "utf8"), all);
    assert.ok("lo" in net && net.lo.rx >= 0 && net.lo.tx >= 0);
});
