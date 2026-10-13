// cinnastat: CPU, memory, disk and network in a tiny 2x2 display on the Cinnamon panel.
// Everything is read straight from /proc, so there is nothing to install.
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

// cells, left to right and top to bottom; rates scale to the busiest sample, with a floor
const CELLS = [
    { key: "cpu", label: "CPU" },
    { key: "mem", label: "RAM" },
    { key: "disk", label: "DISK", floor: 1024 * 1024 },
    { key: "net", label: "NET", floor: 128 * 1024 },
];
const HISTORY = 400;          // samples kept per cell, more than any cell is wide
const SPACE_EVERY = 30;       // ticks between disk space checks (tooltip only)
const DECODER = new TextDecoder();

class CinnastatApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this._history = { cpu: [], mem: [], disk: [], net: [] };
        this._now = { cpu: 0, mem: 0, disk: 0, net: 0 };
        this._prev = null;
        this._physical = new Map();
        this._ticks = 0;
        this._space = null;
        this._timer = 0;

        this._area = new St.DrawingArea({ x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._area.connect("repaint", (area) => this._draw(area));
        this.actor.add_child(this._area);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("interval", "interval", () => this._start());
        this.settings.bind("width", "width", () => this._resize());
        this.settings.bind("command", "command");
        for (const c of CELLS) this.settings.bind(c.key + "-color", c.key + "Color", () => this._area.queue_repaint());

        this._resize();
        this._tick();
        this._start();
    }

    on_applet_clicked() {
        if (this.command) Util.spawnCommandLine(this.command);
    }

    on_applet_removed_from_panel() {
        this._stop();
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
            this._area.set_size(Math.round((Number(this.width) || 132) * global.ui_scale), Math.round(thick * 0.85));
        } else {
            const side = Math.round(thick * 0.85);
            this._area.set_size(side, side);
        }
        this._area.queue_repaint();
    }

    _tick() {
        try {
            this._sample();
            this._area.queue_repaint();
            this.set_applet_tooltip(this._tooltip());
        } catch (e) {
            global.logError("cinnastat: " + e);
        }
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
        const cur = {
            time: GLib.get_monotonic_time() / 1e6,
            cpu: Stats.parseCpu(this._read("/proc/stat")),
            disk: Stats.parseDisks(this._read("/proc/diskstats"), (n) => this._isPhysical(`/sys/block/${n}/device`)),
            net: Stats.parseNet(this._read("/proc/net/dev"), (n) => this._isPhysical(`/sys/class/net/${n}/device`)),
        };
        const mem = Stats.parseMem(this._read("/proc/meminfo"));
        const prev = this._prev;
        this._prev = cur;
        this._mem = mem;
        if (this._ticks++ % SPACE_EVERY === 0) this._space = this._diskSpace();
        if (!prev) return;

        const dt = cur.time - prev.time;
        const n = this._now;
        n.cpu = Stats.cpuPercent(prev.cpu, cur.cpu);
        n.mem = mem.total ? (100 * mem.used) / mem.total : 0;
        n.read = Stats.rate(prev.disk.read, cur.disk.read, dt);
        n.write = Stats.rate(prev.disk.written, cur.disk.written, dt);
        n.rx = Stats.rate(prev.net.rx, cur.net.rx, dt);
        n.tx = Stats.rate(prev.net.tx, cur.net.tx, dt);
        n.disk = n.read + n.write;
        n.net = n.rx + n.tx;
        for (const c of CELLS) Stats.push(this._history[c.key], n[c.key], HISTORY);
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

    _tooltip() {
        const n = this._now;
        const m = this._mem || { total: 0, used: 0, swapUsed: 0 };
        const rate = (v) => Stats.human(v || 0) + "/s";
        const space = this._space && this._space.size > 0
            ? ` · / ${Stats.percent((100 * this._space.used) / this._space.size)} full, ` +
              `${Stats.human(this._space.size - this._space.used)} free`
            : "";
        return [
            `CPU ${Stats.percent(n.cpu)} · load ${Stats.parseLoad(this._read("/proc/loadavg"))}`,
            `Memory ${Stats.percent(n.mem)} · ${Stats.human(m.used)} of ${Stats.human(m.total)}` +
                (m.swapUsed > 0 ? ` · swap ${Stats.human(m.swapUsed)}` : ""),
            `Disk read ${rate(n.read)} · write ${rate(n.write)}${space}`,
            `Network ↓ ${rate(n.rx)} · ↑ ${rate(n.tx)}`,
        ].join("\n");
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const node = area.get_theme_node();
        const fg = node.get_foreground_color();
        const ink = { r: fg.red / 255, g: fg.green / 255, b: fg.blue / 255 };
        const gap = Math.max(1, Math.round(2 * global.ui_scale));
        const cw = Math.floor((w - gap) / 2);
        const ch = Math.floor((h - gap) / 2);

        const font = node.get_font().copy();
        font.set_weight(Pango.Weight.BOLD);
        font.set_absolute_size(Math.max(6, Math.round(ch * 0.62)) * Pango.SCALE);
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(font);

        CELLS.forEach((c, i) => {
            const x = (i % 2) * (w - cw);
            const y = Math.floor(i / 2) * (h - ch);
            this._drawCell(cr, layout, c, x, y, cw, ch, ink);
        });
        cr.$dispose();
    }

    _drawCell(cr, layout, cell, x, y, w, h, ink) {
        const r = Math.min(3 * global.ui_scale, h / 4);
        const color = Stats.parseColor(this[cell.key + "Color"]);

        roundedRect(cr, x, y, w, h, r);
        cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.1);
        cr.fillPreserve();
        cr.save();
        cr.clip();

        // history graph: newest sample on the right edge, one sample per pixel
        const values = this._history[cell.key];
        const max = cell.floor ? Stats.scaleMax(values.slice(-w), cell.floor) : 100;
        const count = Math.min(values.length, w + 1);
        if (count > 1) {
            cr.moveTo(x + w, y + h);
            for (let k = 0; k < count; k++) {
                const v = values[values.length - 1 - k];
                cr.lineTo(x + w - k, y + h - h * Stats.clamp(v / max, 0, 1));
            }
            cr.lineTo(x + w - (count - 1), y + h);
            cr.closePath();
            cr.setSourceRGBA(color.r, color.g, color.b, 0.55 * color.a);
            cr.fill();
        }
        cr.restore();

        // label on the left, value on the right. The label is dropped when the widest
        // possible value would not fit next to it, so it does not blink as values change.
        const pad = Math.max(2, Math.round(3 * global.ui_scale));
        layout.set_text(cell.floor ? "888M" : "100%", -1);
        const [widest] = layout.get_pixel_size();
        layout.set_text(cell.label, -1);
        const [lw] = layout.get_pixel_size();
        const showLabel = pad + lw + pad + widest + pad <= w;

        const value = cell.floor ? Stats.compact(this._now[cell.key]) : Stats.percent(this._now[cell.key]);
        layout.set_text(value, -1);
        const [vw, vh] = layout.get_pixel_size();
        const ty = y + Math.round((h - vh) / 2);
        cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.95);
        cr.moveTo(x + w - pad - vw, ty);
        PangoCairo.show_layout(cr, layout);

        if (showLabel) {
            layout.set_text(cell.label, -1);
            cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.6);
            cr.moveTo(x + pad, ty);
            PangoCairo.show_layout(cr, layout);
        }
    }
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CinnastatApplet(metadata, orientation, panelHeight, instanceId);
}
