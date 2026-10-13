// The hover popup: every CPU core with its own graph, then memory, disk and network
// in detail. Show/hide timing comes from Cinnamon's own tooltips; only the content
// is ours. It is styled as a theme menu, since tooltips use the theme's accent color.
const Tooltips = imports.ui.tooltips;
const Main = imports.ui.main;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const Stats = require("./stats");
const Graph = require("./graph");

const CORE_W = 76;  // core cell size in px, before HiDPI scaling
const CORE_H = 30;
const CORE_GAP = 4;
const ROWS = [
    { key: "cpu", name: "CPU" },
    { key: "mem", name: "Memory" },
    { key: "disk", name: "Disk" },
    { key: "net", name: "Network" },
];

// A label in a hidden actor can go on measuring its previous text after set_text(),
// which left some percentages 1 px wide; an explicit relayout makes it measure again.
function setText(label, text) {
    if (label.get_text() === text) return;
    label.set_text(text);
    label.clutter_text.queue_relayout();
}

// columns of the core grid: one row up to 4 cores, then 4 wide, then 8 wide
function coreColumns(n) {
    return n <= 4 ? Math.max(n, 1) : n <= 16 ? 4 : 8;
}

class Popup extends Tooltips.TooltipBase {
    // source() returns what to show, see CinnastatApplet._popupData()
    constructor(applet, source) {
        super(applet.actor);
        this._applet = applet;
        this._source = source;
        this._data = null;
        this._minWidth = 0;
        this._cores = 0;

        const grid = new Clutter.GridLayout();
        grid.set_column_spacing(Math.round(8 * global.ui_scale));
        grid.set_row_spacing(Math.round(6 * global.ui_scale));
        this._box = new St.Widget({ style_class: "menu cinnastat-popup", layout_manager: grid, reactive: false });

        this._rows = {};
        let line = 0;
        for (const r of ROWS) {
            const row = {
                dot: new St.Label({ text: "●", y_align: Clutter.ActorAlign.START }),
                name: new St.Label({ text: r.name, style_class: "cinnastat-name", y_align: Clutter.ActorAlign.START }),
                pct: new St.Label({ style_class: "cinnastat-pct", x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START }),
                detail: new St.Label({ style_class: "cinnastat-detail", y_align: Clutter.ActorAlign.START }),
            };
            row.detail.opacity = 190;
            // nothing here should ever be cut to "…"
            for (const l of [row.name, row.pct, row.detail]) l.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            grid.attach(row.dot, 0, line, 1, 1);
            grid.attach(row.name, 1, line, 1, 1);
            grid.attach(row.pct, 2, line, 1, 1);
            grid.attach(row.detail, 3, line, 1, 1);
            this._rows[r.key] = row;
            line++;
            if (r.key === "cpu") {
                this._coreArea = new St.DrawingArea({ style_class: "cinnastat-cores" });
                this._coreArea.connect("repaint", (area) => this._paintCores(area));
                grid.attach(this._coreArea, 1, line, 3, 1);
                line++;
            }
        }

        Main.uiGroup.add_child(this._box);
        this._box.hide();
    }

    show() {
        if (!this._box || global.menuStack.length > 0) return;
        this._minWidth = 0;
        this._box.set_width(-1);
        this.update();
        this._box.show();
        this.visible = true;
        this._place();
    }

    hide() {
        if (this._box) this._box.hide();
        this.visible = false;
    }

    _destroy() {
        if (this._box) this._box.destroy();
        this._box = null;
    }

    update() {
        if (!this._box) return;
        const d = (this._data = this._source());
        for (const r of ROWS) {
            const row = this._rows[r.key];
            const [pct, detail] = d.rows[r.key];
            row.dot.set_style(`color: ${d.colors[r.key]};`);
            setText(row.pct, pct);
            setText(row.detail, detail);
        }

        const n = d.cores.length;
        if (n !== this._cores) {
            this._cores = n;
            const s = global.ui_scale;
            const cols = coreColumns(n);
            const rows = Math.ceil(n / cols);
            this._coreArea.set_size(
                Math.round(cols * CORE_W * s + (cols - 1) * CORE_GAP * s),
                Math.round(rows * CORE_H * s + Math.max(0, rows - 1) * CORE_GAP * s));
        }
        this._coreArea.queue_repaint();

        // grow to fit, never shrink while open, so the popup does not twitch as numbers change
        this._box.set_width(-1);
        const natural = this._box.get_preferred_width(-1)[1];
        this._minWidth = Math.max(this._minWidth, natural);
        this._box.set_width(this._minWidth);
        if (this.visible) this._place();
    }

    // next to the applet, on the side away from the panel, kept inside the monitor
    _place() {
        const actor = this._applet.actor;
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        const w = this._minWidth;
        const h = this._box.get_preferred_height(w)[1];
        const m = Main.layoutManager.findMonitorForActor(actor);
        const gap = Math.round(6 * global.ui_scale);
        let x = ax + (aw - w) / 2;
        let y = ay - h - gap;
        switch (this._applet._orientation) {
            case St.Side.TOP: y = ay + ah + gap; break;
            case St.Side.LEFT: x = ax + aw + gap; y = ay + (ah - h) / 2; break;
            case St.Side.RIGHT: x = ax - w - gap; y = ay + (ah - h) / 2; break;
        }
        x = Stats.clamp(x, m.x + gap, m.x + m.width - w - gap);
        y = Stats.clamp(y, m.y + gap, m.y + m.height - h - gap);
        this._box.set_position(Math.round(x), Math.round(y));
    }

    _paintCores(area) {
        const cr = area.get_context();
        const d = this._data;
        if (d && d.cores.length) {
            const s = global.ui_scale;
            const ink = Graph.inkOf(area);
            const color = Stats.parseColor(d.colors.cpu);
            const cols = coreColumns(d.cores.length);
            const cw = CORE_W * s;
            const ch = CORE_H * s;
            const pad = Math.round(5 * s);

            const font = area.get_theme_node().get_font().copy();
            font.set_absolute_size(Math.round(ch * 0.4) * Pango.SCALE);
            const layout = PangoCairo.create_layout(cr);

            d.cores.forEach((pct, i) => {
                const x = (i % cols) * (cw + CORE_GAP * s);
                const y = Math.floor(i / cols) * (ch + CORE_GAP * s);
                Graph.paintCell(cr, x, y, cw, ch, d.coreHistory[i] || [], 100, color, ink);

                font.set_weight(Pango.Weight.BOLD);
                layout.set_font_description(font);
                layout.set_text(Stats.percent(pct), -1);
                const [vw, vh] = layout.get_pixel_size();
                const ty = y + Math.round((ch - vh) / 2);
                cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.95);
                cr.moveTo(x + cw - pad - vw, ty);
                PangoCairo.show_layout(cr, layout);

                font.set_weight(Pango.Weight.NORMAL);
                layout.set_font_description(font);
                layout.set_text(`#${i + 1}`, -1);
                cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.6);
                cr.moveTo(x + pad, ty);
                PangoCairo.show_layout(cr, layout);
            });
        }
        cr.$dispose();
    }
}

module.exports = { Popup };
