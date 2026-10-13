// Cairo drawing shared by the panel display and the hover popup.
const Stats = require("./stats");

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

// a rounded cell with a filled history graph: newest sample on the right edge,
// one sample per pixel, `max` at the top. ink is the text color, as { r, g, b }.
function paintCell(cr, x, y, w, h, values, max, color, ink) {
    const r = Math.min(3 * global.ui_scale, h / 4);
    roundedRect(cr, x, y, w, h, r);
    cr.setSourceRGBA(ink.r, ink.g, ink.b, 0.1);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    const count = Math.min(values.length, Math.floor(w) + 1);
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
}

// the theme's text color of a drawing area, as { r, g, b } in 0..1
function inkOf(area) {
    const fg = area.get_theme_node().get_foreground_color();
    return { r: fg.red / 255, g: fg.green / 255, b: fg.blue / 255 };
}

module.exports = { roundedRect, paintCell, inkOf };
