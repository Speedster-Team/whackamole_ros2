# whackamole-ros

ROS 2 (Kilted) package for the whack-a-mole robotic finger reaction-time test bed.

A Next.js web app runs on an iPad. Random targets appear on screen after random delays. The ROS node receives each target's pixel coordinates over WebSocket and publishes them so a motion controller can move the robot finger to that position. Hit/miss outcomes and reaction times are published for logging.

## Architecture

```
iPad (Next.js app)
  │  WebSocket  ws://<robot-ip>:8765
  ▼
whackamole_node (C++ / Boost.Beast)
  ├── /whackamole/target  →  motion controller node
  ├── /whackamole/hit_ms  →  data logger
  └── /whackamole/miss    →  data logger
```

The Beast WebSocket server runs on its own thread; the rclcpp executor runs on the main thread. Publishers are thread-safe so no extra synchronisation is needed.

## Prerequisites

**ROS 2 Kilted** plus:

```bash
sudo apt install libboost-dev nlohmann-json3-dev nodejs npm
```

## Build

```bash
cd whackamole-ros
colcon build --symlink-install
source install/setup.bash
```

`--symlink-install` symlinks the `webapp/` directory into the install tree so `node_modules` installed there stays in sync with the source.

## Launch

```bash
ros2 launch whackamole_ros2 whackamole.launch.xml
```

This starts the ROS WebSocket node and the Next.js dev server (`npm install && npm run dev`) together. On the first launch `npm install` may take a minute; subsequent launches are fast.

On the iPad, open:
```
http://<robot-machine-ip>:4000
```
The WebSocket URL pre-fills to `ws://<same-host>:8765`. Tap **Connect**.

## Topics

| Topic | Type | Description |
|---|---|---|
| `/whackamole/target` | `geometry_msgs/msg/Point` | Dot centre in iPad CSS pixels. `x`, `y` = position; `z` = dot diameter. Published on every spawn. |
| `/whackamole/hit_ms` | `std_msgs/msg/Int32` | Reaction time in milliseconds when the finger hits the dot. |
| `/whackamole/miss` | `std_msgs/msg/String` | Miss reason (e.g. `timeout`) when the dot expires unhit. |

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `host` | `0.0.0.0` | WebSocket bind address |
| `port` | `8765` | WebSocket port |

Override at launch:
```bash
ros2 launch whackamole_ros2 whackamole.launch.xml port:=9000
```

## Coordinate system

All `x`/`y` values in `/whackamole/target` are **CSS pixels in the iPad viewport**, origin top-left. The `hello` message logged at connection time includes the viewport size, play area bounds, and device pixel ratio — use these to calibrate the mapping from screen pixels to your robot's workspace frame.

## Package structure

```
src/whackamole_ros2/
  CMakeLists.txt
  package.xml
  src/
    whackamole_node.cpp    C++ ROS node + Beast WebSocket server
  launch/
    whackamole.launch.xml  starts node + npm dev server
  webapp/
    app/                  Next.js source (page.tsx, layout.tsx, globals.css)
    package.json
    next.config.ts
    ...
```
