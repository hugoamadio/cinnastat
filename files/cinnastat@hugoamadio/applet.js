// cinnastat: CPU, memory, disk and network in a tiny 2x2 display on the Cinnamon panel.
// Everything is read straight from /proc and /sys, so there is nothing to install.
const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const Stats = require("./stats");
const Graph = require("./graph");
const { Popup } = require("./popup");

// cells, left to right and top to bottom. Each shows a label, an optional detail
// and a percentage over its history graph. `widest` sizes the detail column.
const CELLS = [
    { key: "cpu", label: "CPU" },
    { key: "mem", label: "RAM", widest: "88/88G" },
    { key: "disk", label: "DISK", widest: "888M" },
    { key: "net", label: "NET", widest: "888M" },
];
const HISTORY = 600;          // samples kept per cell, more than any cell is wide
const CORE_HISTORY = 200;     // samples kept per core, for the popup
const SPACE_EVERY = 30;       // ticks between disk space checks (tooltip only)
const LINKS_EVERY = 10;       // ticks between link speed checks
const NET_FLOOR = 128 * 1024; // graph scale when no link speed is known
const NM = "org.freedesktop.NetworkManager";
const DECODER = new TextDecoder();

class CinnastatApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this._history = { cpu: [], mem: [], disk: [], net: [], netRate: [] };
        this._coreHistory = [];
        this._now = { cpu: 0, cores: [], mem: 0, disk: 0, net: null };
        this._prev = null;
        this._mem = null;
        this._physical = new Map();
        this._links = new Map();
        this._ticks = 0;
        this._space = null;
        this._timer = 0;

        this._area = new St.DrawingArea({ x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._area.connect("repaint", (area) => this._draw(area));
        this.actor.add_child(this._area);
        this._popup = new Popup(this, () => this._popupData());

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("interval", "interval", () => this._start());
        this.settings.bind("width", "width", () => this._resize());
        this.settings.bind("command", "command");
        for (const c of CELLS) this.settings.bind(c.key + "-color", c.key + "Color", () => this._redraw());

        this._resize();
        this._tick();
        this._start();
    }

    on_applet_clicked() {
        if (this.command) Util.spawnCommandLine(this.command);
    }

    on_applet_removed_from_panel() {
        this._stop();
        this._popup.destroy();
        this.settings.finalize();
    }

    on_panel_height_changed() {
        this._resize();
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        if (this._area) this._resize();
    }

    _start() {
        this._stop();
        const ms = Math.max(250, Number(this.interval) || 1000);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
    }

    // horizontal panel: a box as tall as the panel allows and `width` px wide;
    // vertical panel: a square as wide as the panel
    _resize() {
        const thick = this.panel ? this.panel.height : 40;
        const horizontal = this._orientation === St.Side.TOP || this._orientation === St.Side.BOTTOM;
        if (horizontal) {
            this._area.set_size(Math.round((Number(this.width) || 212) * global.ui_scale), Math.round(thick * 0.85));
        } else {
            const side = Math.round(thick * 0.85);
            this._area.set_size(side, side);
        }
        this._area.queue_repaint();
    }

    _tick() {
        try {
            this._sample();
            this._redraw();
        } catch (e) {
            global.logError("cinnastat: " + e);
        }
    }

    _redraw() {
        this._area.queue_repaint();
        if (this._popup.visible) this._popup.update();
    }

    _read(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? DECODER.decode(bytes) : "";
        } catch (e) {
            return "";
        }
    }

    // real hardware has a `device` link in sysfs; loop, dm, zram, lo, docker, veth and vpn do not
    _isPhysical(path) {
        let yes = this._physical.get(path);
        if (yes === undefined) {
            if (this._physical.size > 256) this._physical.clear(); // container churn creates new veth names
            yes = GLib.file_test(path, GLib.FileTest.EXISTS);
            this._physical.set(path, yes);
        }
        return yes;
    }

    _sample() {
        const stat = this._read("/proc/stat");
        const cur = {
            time: GLib.get_monotonic_time() / 1e6,
            cpu: Stats.parseCpu(stat),
            cores: Stats.parseCores(stat),
            disks: Stats.parseDisks(this._read("/proc/diskstats"), (n) => this._isPhysical(`/sys/block/${n}/device`)),
            net: Stats.parseNet(this._read("/proc/net/dev"), (n) => this._isPhysical(`/sys/class/net/${n}/device`)),
        };
        const prev = this._prev;
        this._prev = cur;
        this._mem = Stats.parseMem(this._read("/proc/meminfo"));
        if (this._ticks % SPACE_EVERY === 0) this._space = this._diskSpace();
        if (this._ticks % LINKS_EVERY === 0) this._refreshLinks(Object.keys(cur.net));
        this._ticks++;
        if (!prev) return;

        const dt = cur.time - prev.time;
        const n = this._now;
        const m = this._mem;
        n.cpu = Stats.cpuPercent(prev.cpu, cur.cpu);
        n.cores = cur.cores.map((c, i) => Stats.cpuPercent(prev.cores[i], c));
        n.cores.forEach((pct, i) => Stats.push(this._coreHistory[i] || (this._coreHistory[i] = []), pct, CORE_HISTORY));
        this._coreHistory.length = n.cores.length;
        n.mem = m.total ? (100 * m.used) / m.total : 0;
        n.disk = Stats.diskBusy(prev.disks, cur.disks, dt);
        n.read = Stats.rate(Stats.total(prev.disks, "read"), Stats.total(cur.disks, "read"), dt);
        n.write = Stats.rate(Stats.total(prev.disks, "written"), Stats.total(cur.disks, "written"), dt);
        n.net = Stats.netBusy(prev.net, cur.net, dt, Object.fromEntries(this._links));
        n.rx = Stats.rate(Stats.total(prev.net, "rx"), Stats.total(cur.net, "rx"), dt);
        n.tx = Stats.rate(Stats.total(prev.net, "tx"), Stats.total(cur.net, "tx"), dt);

        const h = this._history;
        Stats.push(h.cpu, n.cpu, HISTORY);
        Stats.push(h.mem, n.mem, HISTORY);
        Stats.push(h.disk, n.disk, HISTORY);
        Stats.push(h.net, n.net || 0, HISTORY);
        Stats.push(h.netRate, n.rx + n.tx, HISTORY);
    }

    // link speed of every connected interface: cable from sysfs, Wi-Fi from NetworkManager
    // (the kernel has no speed for Wi-Fi). Interfaces without a speed are left out of NET %.
    _refreshLinks(names) {
        for (const name of this._links.keys()) if (!names.includes(name)) this._links.delete(name);
        for (const name of names) {
            const dir = `/sys/class/net/${name}`;
            if (this._read(`${dir}/operstate`).trim() !== "up") {
                this._links.delete(name);
            } else if (GLib.file_test(`${dir}/wireless`, GLib.FileTest.IS_DIR)) {
                this._wifiBitrate(name);
            } else {
                const mbps = parseInt(this._read(`${dir}/speed`), 10);
                if (mbps > 0) this._links.set(name, { bps: mbps * 1e6, wireless: false });
                else this._links.delete(name);
            }
        }
    }

    _wifiBitrate(name) {
        const drop = () => this._links.delete(name);
        const bus = Gio.DBus.system;
        bus.call(NM, "/org/freedesktop/NetworkManager", NM, "GetDeviceByIpIface",
            new GLib.Variant("(s)", [name]), new GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 2000, null,
            (conn, res) => {
                try {
                    const path = conn.call_finish(res).deep_unpack()[0];
                    conn.call(NM, path, "org.freedesktop.DBus.Properties", "Get",
                        new GLib.Variant("(ss)", [NM + ".Device.Wireless", "Bitrate"]), new GLib.VariantType("(v)"),
                        Gio.DBusCallFlags.NONE, 2000, null, (conn2, res2) => {
                            try {
                                const kbps = conn2.call_finish(res2).get_child_value(0).get_variant().get_uint32();
                                if (kbps > 0) this._links.set(name, { bps: kbps * 1000, wireless: true });
                                else drop();
                            } catch (e) {
                                drop();
                            }
                        });
                } catch (e) {
                    drop();
                }
            });
    }

    _diskSpace() {
        try {
            const info = Gio.File.new_for_path("/").query_filesystem_info("filesystem::size,filesystem::free", null);
            const size = info.get_attribute_uint64("filesystem::size");
            return { size, used: size - info.get_attribute_uint64("filesystem::free") };
        } catch (e) {
            return null;
        }
    }

    // everything the hover popup shows: [percentage, details] per row, plus the cores
    _popupData() {
        const n = this._now;
        const m = this._mem || { total: 0, used: 0, swapUsed: 0 };
        const rate = (v) => Stats.human(v || 0) + "/s";
        const sp = this._space;
        const links = [...this._links.values()]
            .map((l) => `${l.wireless ? "Wi-Fi" : "cable"} ${Stats.bitrate(l.bps)}`)
            .join(" · ");
        return {
            colors: { cpu: this.cpuColor, mem: this.memColor, disk: this.diskColor, net: this.netColor },
            cores: n.cores,
            coreHistory: this._coreHistory,
            rows: {
                cpu: [Stats.percent(n.cpu),
                    `average of ${n.cores.length} threads · load ${Stats.parseLoad(this._read("/proc/loadavg"))}`],
                mem: [Stats.percent(n.mem),
                    `${Stats.human(m.used)} of ${Stats.human(m.total)}` + (m.swapUsed > 0 ? ` · swap ${Stats.human(m.swapUsed)}` : "")],
                disk: [Stats.percent(n.disk),
                    `read ${rate(n.read)} · write ${rate(n.write)}` +
                    (sp && sp.size > 0 ? `\n${Stats.percent((100 * sp.used) / sp.size)} full · ${Stats.human(sp.size - sp.used)} free` : "")],
                net: [n.net === null ? "–" : Stats.percent(n.net),
                    `↓ ${rate(n.rx)} · ↑ ${rate(n.tx)}` + (links ? `\n${links}` : "")],
            },
        };
    }

    // [detail, value] of a cell; NET shows only its traffic when no link speed is known
    _texts(key) {
        const n = this._now;
        const m = this._mem || { total: 0, used: 0 };
        switch (key) {
            case "cpu": return ["", Stats.percent(n.cpu)];
            case "mem": return [Stats.usedOf(m.used, m.total), Stats.percent(n.mem)];
            case "disk": return [Stats.compact((n.read || 0) + (n.write || 0)), Stats.percent(n.disk)];
            default: {
                const traffic = Stats.compact((n.rx || 0) + (n.tx || 0));
                return n.net === null ? ["", traffic] : [traffic, Stats.percent(n.net)];
            }
        }
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const node = area.get_theme_node();
        const ink = Graph.inkOf(area);
        const gap = Math.max(1, Math.round(2 * global.ui_scale));
        const cw = Math.floor((w - gap) / 2);
        const ch = Math.floor((h - gap) / 2);

        const size = Math.max(6, Math.round(ch * 0.62)) * Pango.SCALE;
        const bold = node.get_font().copy();
        bold.set_weight(Pango.Weight.BOLD);
        bold.set_absolute_size(size);
        const regular = bold.copy();
        regular.set_weight(Pango.Weight.NORMAL);
        const fonts = { bold: PangoCairo.create_layout(cr), regular: PangoCairo.create_layout(cr) };
        fonts.bold.set_font_description(bold);
        fonts.regular.set_font_description(regular);

        CELLS.forEach((c, i) => {
            const x = (i % 2) * (w - cw);
            const y = Math.floor(i / 2) * (h - ch);
            this._drawCell(cr, fonts, c, x, y, cw, ch, ink);
        });
        cr.$dispose();
    }

    _drawCell(cr, fonts, cell, x, y, w, h, ink) {
        const rateOnly = cell.key === "net" && this._now.net === null;
        Graph.paintCell(cr, x, y, w, h,
            rateOnly ? this._history.netRate : this._history[cell.key],
            rateOnly ? Stats.scaleMax(this._history.netRate.slice(-w), NET_FLOOR) : 100,
            Stats.parseColor(this[cell.key + "Color"]), ink);

        // label on the left, value on the right, detail just before the value column.
        // Room is checked against the widest possible texts, so nothing blinks as values
        // change: the detail goes first when space is short, then the label.
        const label = cell.label;
        const [detail, value] = this._texts(cell.key);
        const pad = Math.max(2, Math.round(3 * global.ui_scale));
        const width = (layout, text) => {
            layout.set_text(text, -1);
            return layout.get_pixel_size()[0];
        };
        const valueCol = width(fonts.bold, "100%");
        const lw = width(fonts.bold, label);
        const dw = cell.widest ? width(fonts.regular, cell.widest) : 0;
        const showLabel = pad + lw + pad + valueCol + pad <= w;
        const showDetail = detail && showLabel && pad + lw + 2 * pad + dw + pad + valueCol + pad <= w;

        fonts.bold.set_text(value, -1);
        const [vw, vh] = fonts.bold.get_pixel_size();
        const ty = y + Math.round((h - vh) / 2);
        cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.95);
        cr.moveTo(x + w - pad - vw, ty);
        PangoCairo.show_layout(cr, fonts.bold);

        if (showDetail) {
            const tw = width(fonts.regular, detail);
            cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.8);
            cr.moveTo(x + w - pad - valueCol - pad - tw, ty);
            PangoCairo.show_layout(cr, fonts.regular);
        }
        if (showLabel) {
            fonts.bold.set_text(label, -1);
            cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.6);
            cr.moveTo(x + pad, ty);
            PangoCairo.show_layout(cr, fonts.bold);
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CinnastatApplet(metadata, orientation, panelHeight, instanceId);
}
