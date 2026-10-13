<div align="center">

# cinnastat

**CPU, memory, disk and network in a tiny 2×2 display on your Linux Mint panel.**

One glance at the panel tells you whether the machine is busy, and why: a runaway process, memory
running out, a disk working hard or a big download. No terminal, no window to open.

[![ci](https://github.com/hugoamadio/cinnastat/actions/workflows/ci.yml/badge.svg)](https://github.com/hugoamadio/cinnastat/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Cinnamon applet](https://img.shields.io/badge/Cinnamon-applet-dc682e?logo=linuxmint&logoColor=white)

<img src="screenshot.png" alt="cinnastat on the Cinnamon panel: CPU 18%, RAM 18 of 31 GB at 57%, disk 226 MB/s at 54% busy, network 82 KB/s at 0% of the link, each over a small history graph" width="760">

<sub>Actual size is 212×34 px, shown here at 4×.</sub>

</div>

## What it shows

Every cell is a percentage, so 100% always means "at the limit", over a graph of its last minute or so.

| Cell | Detail | 100% means |
| --- | --- | --- |
| **CPU** | | every CPU thread busy (the value is the average of all of them) |
| **RAM** | in use / total, e.g. `18/31G` | no memory left the kernel can hand out |
| **DISK** | read + write per second | the busiest disk never stopped working, like *active time* in the Windows Task Manager or `%util` in `iostat` |
| **NET** | download + upload per second | the busiest connection is using all of its link speed: the negotiated speed for a cable, the current bitrate for Wi-Fi |

Hover for every CPU core with its own graph, and the details behind the other three:

<img src="docs/popup.png" alt="cinnastat hover popup: 8 CPU cores each with a small graph and percentage, then memory 18.1 GB of 31.1 GB, disk read/write and free space, network down/up and link speeds" width="600">

Wi-Fi speed comes from NetworkManager, which every Mint install has. Without it, NET shows the traffic
itself, over a graph that scales to the busiest moment on screen.

Click to open System Monitor on its Resources tab.

## Install

```bash
git clone https://github.com/hugoamadio/cinnastat.git
cd cinnastat
./install.sh
```

Then right-click the panel → **Applets**, select **cinnastat** and click **+**. Drag it where you want it
while the panel is in edit mode.

To update, `git pull` and run `./install.sh` again. To uninstall, `./install.sh --remove`.

## Settings

Right-click → **Configure**:

| Setting | Default |
| --- | --- |
| Update every | 1000 ms |
| Width on a horizontal panel | 212 px (height follows the panel; narrower hides the details, then the labels) |
| Colors | blue CPU, purple RAM, orange disk, green network |
| Command to run on click | `gnome-system-monitor -r` (empty = do nothing) |

The display follows the panel: its height tracks the panel height, on a vertical panel it becomes a
square as wide as the panel, and the text uses your theme's panel font and color.

## Why it is light

- **No dependencies.** Everything comes from `/proc` (`stat`, `meminfo`, `diskstats`, `net/dev`), the same
  files `top` and `free` read, plus link speeds from `/sys` and NetworkManager every 10 seconds. No Python,
  no `libgtop`, no background daemon.
- **Five tiny file reads per second** and one small redraw. It lives inside Cinnamon, so it adds no process.
- **Honest totals.** Only real hardware is counted: physical disks (not loop devices, partitions or LVM/LUKS
  layers on top of them) and physical network cards (not `lo`, Docker bridges, `veth` pairs or VPN tunnels).
  Traffic that crosses a VPN or a container network is counted once, on the card that actually sent it.

## Development

```bash
./install.sh --link       # symlink, so your edits are live after a reload
node --test test/*.test.js
```

Reload the applet after editing:

```bash
dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call /org/Cinnamon/LookingGlass \
  org.Cinnamon.LookingGlass.ReloadExtension string:cinnastat@hugoamadio string:APPLET
```

[`stats.js`](files/cinnastat@hugoamadio/stats.js) reads and formats the numbers. It is plain JavaScript
with no Cinnamon imports, so the tests run under Node. [`applet.js`](files/cinnastat@hugoamadio/applet.js)
draws the panel display, [`popup.js`](files/cinnastat@hugoamadio/popup.js) the hover popup and
[`graph.js`](files/cinnastat@hugoamadio/graph.js) the graph cells both share. Errors from the applet show up in `~/.xsession-errors` and in Looking
Glass (`Alt+F2`, `lg`).

Tested on Linux Mint 22.3 with Cinnamon 6.6. Issues and pull requests are welcome.

If cinnastat earns its spot on your panel, a ⭐ helps other Mint users find it.

## License

[MIT](LICENSE)
