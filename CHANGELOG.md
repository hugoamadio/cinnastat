# Changelog

## 0.1.0 (unreleased)

First version.

- 2×2 display with CPU, memory, disk and network as percentages, each over a history graph.
- RAM shows used/total next to the percentage; DISK and NET show their traffic per second.
- DISK % is the busiest disk's busy time; NET % is the busiest connection's share of its link speed
  (cable speed from the kernel, Wi-Fi bitrate from NetworkManager).
- Tooltip with the CPU average and busiest thread, load average, memory and swap in GB, disk read/write
  and free space, network down/up and link speeds.
- Click opens System Monitor (configurable).
- Settings for update interval, width, colors and click command.
- Counts physical disks and network cards only, so Docker, VPN and LVM traffic is not counted twice.
