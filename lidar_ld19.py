import tkinter as tk
import threading
import serial
import socket
import json
import math
import os
import time

from collections import defaultdict


# =====================================================
# CONFIGURATION
# =====================================================

# Physical wall
WALL_WIDTH_IN = 149.0
WALL_HEIGHT_IN = 80.0

DEAD_LEFT_IN = 4.0
DEAD_RIGHT_IN = 4.0

SENSOR_Y_DEFAULT = 38.0

MM = 25.4

WALL_W = WALL_WIDTH_IN * MM
WALL_H = WALL_HEIGHT_IN * MM

ACTIVE_X0 = DEAD_LEFT_IN * MM
ACTIVE_X1 = (
    WALL_WIDTH_IN - DEAD_RIGHT_IN
) * MM

ACTIVE_WIDTH = ACTIVE_X1 - ACTIVE_X0

# Viewer window: 10 pixels per inch
PPI = 10

WINDOW_WIDTH = int(WALL_WIDTH_IN * PPI)
WINDOW_HEIGHT = int(WALL_HEIGHT_IN * PPI)

# LD19
PORT = "COM7"
BAUD = 230400

PACKET_SIZE = 47
BIN_COUNT = 720

MIN_RANGE = 80
MAX_RANGE = 12000
MIN_INTENSITY = 10

SCAN_STALE_SECONDS = 0.25

# Background detection
BACKGROUND_DIFFERENCE = 75
BACKGROUND_NEIGHBORS = 3

CAPTURE_SECONDS = 1.5
AUTO_CAPTURE_DELAY = 2.0

# Tracking
CLUSTER_MAX_GAP = 115
CLUSTER_INDEX_GAP = 3

MIN_CLUSTER_POINTS = 2
MAX_CLUSTER_POINTS = 28

TRACK_GATE = 320
TRACK_TTL = 0.27

MOVE_THRESHOLD = 6
HEARTBEAT = 0.08

# Game connection
UDP_HOST = "127.0.0.1"
UDP_PORT = 5005

SETTINGS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "lidar_settings.json"
)

LAYOUT_ID = "149x80_4_4_38"


# =====================================================
# CRC8
# =====================================================

def crc8(data):
    crc = 0

    for byte in data:
        crc ^= byte

        for _ in range(8):
            if crc & 0x80:
                crc = (
                    (crc << 1) ^ 0x4D
                ) & 0xFF
            else:
                crc = (crc << 1) & 0xFF

    return crc


# =====================================================
# LD19 SERIAL READER
# =====================================================

class LD19Reader:

    def __init__(self):
        self.lock = threading.Lock()

        self.bins = {}

        self.valid_packets = 0
        self.bad_packets = 0

        self.rpm = 0
        self.last_packet = 0

        self.error = ""

        self.stop_event = threading.Event()
        self.thread = None

    def start(self, port):
        self.stop_event.clear()

        self.thread = threading.Thread(
            target=self.read_loop,
            args=(port,),
            daemon=True
        )

        self.thread.start()

    def read_loop(self, port):
        try:
            with serial.Serial(
                port=port,
                baudrate=BAUD,
                timeout=0.02
            ) as device:

                buffer = bytearray()

                while not self.stop_event.is_set():
                    incoming = device.read(
                        device.in_waiting or 1
                    )

                    if incoming:
                        buffer.extend(incoming)

                    while len(buffer) >= PACKET_SIZE:
                        header_index = buffer.find(
                            b"\x54\x2c"
                        )

                        if header_index < 0:
                            del buffer[:-1]
                            break

                        if header_index > 0:
                            del buffer[:header_index]

                        if len(buffer) < PACKET_SIZE:
                            break

                        packet = bytes(
                            buffer[:PACKET_SIZE]
                        )

                        if crc8(packet[:-1]) != packet[-1]:
                            with self.lock:
                                self.bad_packets += 1

                            del buffer[0]
                            continue

                        del buffer[:PACKET_SIZE]

                        self.parse_packet(packet)

        except (OSError, serial.SerialException) as error:
            with self.lock:
                self.error = str(error)

    def parse_packet(self, packet):
        speed = int.from_bytes(
            packet[2:4],
            "little"
        )

        start = int.from_bytes(
            packet[4:6],
            "little"
        )

        end = int.from_bytes(
            packet[42:44],
            "little"
        )

        sweep = (end - start) % 36000

        # Reject implausible packet angle jumps.
        if sweep > 9000:
            return

        step = sweep / 11.0

        now = time.monotonic()

        points = []

        for i in range(12):
            offset = 6 + i * 3

            distance = int.from_bytes(
                packet[offset:offset + 2],
                "little"
            )

            intensity = packet[offset + 2]

            angle = (
                (start + i * step) / 100.0
            ) % 360.0

            bin_index = int(
                angle * 2
            ) % BIN_COUNT

            points.append((
                bin_index,
                distance,
                intensity,
                now
            ))

        with self.lock:
            for bin_index, distance, intensity, stamp in points:
                self.bins[bin_index] = (
                    distance,
                    intensity,
                    stamp
                )

            self.valid_packets += 1
            self.rpm = speed / 6.0
            self.last_packet = now

    def snapshot(self):
        now = time.monotonic()

        with self.lock:
            scan = [
                (
                    index,
                    index * 0.5,
                    distance,
                    intensity
                )
                for index, (distance, intensity, stamp)
                in self.bins.items()
                if now - stamp < SCAN_STALE_SECONDS
            ]

            stats = {
                "valid": self.valid_packets,
                "bad": self.bad_packets,
                "rpm": self.rpm,
                "age": (
                    now - self.last_packet
                    if self.last_packet
                    else 999
                ),
                "error": self.error
            }

        scan.sort(key=lambda point: point[0])

        return scan, stats

    def close(self):
        self.stop_event.set()

        if self.thread:
            self.thread.join(timeout=0.5)


# =====================================================
# LIVE LIDAR MAP
# =====================================================

class LidarStudio:

    def __init__(self, root):
        self.root = root

        root.title(
            "LD19 LIVE MAP | Olympic Archery | 149 x 80 in"
        )

        root.geometry(
            f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}"
        )

        root.configure(bg="#0D2037")

        self.canvas = tk.Canvas(
            root,
            bg="#0D2037",
            highlightthickness=0,
            bd=0
        )

        self.canvas.pack(
            fill="both",
            expand=True
        )

        # Sensor orientation
        self.sensor_y = SENSOR_Y_DEFAULT
        self.forward_angle = 0.0
        self.mirror_y = False

        self.load_settings()

        # Viewer settings
        self.show_grid = True
        self.show_info = True
        self.show_raw = False

        self.demo_mode = False
        self.demo_pressed = False

        self.fullscreen = False

        # Sensor status
        self.status = "Starting"
        self.reader = None

        # Background
        self.background = None
        self.background_enabled = False

        self.capture_end = None
        self.capture_samples = defaultdict(list)

        self.first_live = None
        self.auto_capture_done = False

        # Touch tracking
        self.tracks = {}
        self.next_track_id = 1

        # id -> dict:
        # x, y, seen, sent_x, sent_y, last_emit

        self.last_points = []
        self.last_stats = {}

        # UDP output
        self.udp = socket.socket(
            socket.AF_INET,
            socket.SOCK_DGRAM
        )

        # Mouse demo
        self.canvas.bind(
            "<ButtonPress-1>",
            self.mouse_down
        )

        self.canvas.bind(
            "<B1-Motion>",
            self.mouse_move
        )

        self.canvas.bind(
            "<ButtonRelease-1>",
            self.mouse_up
        )

        self.root.bind(
            "<Key>",
            self.on_key
        )

        root.protocol(
            "WM_DELETE_WINDOW",
            self.close
        )

        self.connect()
        self.tick()

    # =================================================
    # SETTINGS
    # =================================================

    def load_settings(self):
        try:
            with open(
                SETTINGS_FILE,
                "r",
                encoding="utf-8"
            ) as file:
                data = json.load(file)

            if data.get("layout") != LAYOUT_ID:
                return

            self.sensor_y = float(
                data.get(
                    "sensor_y",
                    self.sensor_y
                )
            )

            self.forward_angle = float(
                data.get(
                    "forward_angle",
                    self.forward_angle
                )
            )

            self.mirror_y = bool(
                data.get(
                    "mirror_y",
                    self.mirror_y
                )
            )

        except (OSError, ValueError, TypeError):
            pass

    def save_settings(self):
        data = {
            "layout": LAYOUT_ID,
            "sensor_y": self.sensor_y,
            "forward_angle": self.forward_angle,
            "mirror_y": self.mirror_y
        }

        try:
            with open(
                SETTINGS_FILE,
                "w",
                encoding="utf-8"
            ) as file:
                json.dump(
                    data,
                    file,
                    indent=2
                )
        except OSError:
            pass

    # =================================================
    # CONNECTION
    # =================================================

    def connect(self):
        if self.reader:
            self.reader.close()

            if (
                self.reader.thread
                and self.reader.thread.is_alive()
            ):
                self.status = (
                    "Previous serial reader is closing"
                )
                return

        self.clear_tracks()

        self.background = None
        self.background_enabled = False

        self.capture_end = None
        self.capture_samples.clear()

        self.first_live = None
        self.auto_capture_done = False

        self.reader = LD19Reader()
        self.reader.start(PORT)

        self.status = (
            f"Connecting to {PORT} at {BAUD} baud"
        )

    # =================================================
    # WALL COORDINATES
    # =================================================

    def in_active_area(self, x, y):
        return (
            ACTIVE_X0 <= x <= ACTIVE_X1
            and 0 <= y <= WALL_H
        )

    def polar_to_xy(self, angle, distance):
        theta = math.radians(
            angle - self.forward_angle
        )

        sign = -1 if self.mirror_y else 1

        x = distance * math.cos(theta)

        y = (
            self.sensor_y * MM
            + sign * distance * math.sin(theta)
        )

        return x, y

    # =================================================
    # UDP TO THE ARCHERY GAME
    # =================================================

    def send_event(self, kind, track_id, x, y):
        if (
            kind != "touch_up"
            and not self.in_active_area(x, y)
        ):
            return

        x_inches = x / MM
        y_inches = y / MM

        # NOTE:
        # x_norm represents the FULL 149-inch wall,
        # not just the 141-inch active region.
        #
        # This matches the archery game's full-width
        # coordinate mapping.

        payload = {
            "type": kind,
            "id": track_id,

            "x_mm": round(x, 2),
            "y_mm": round(y, 2),

            "x_inches": round(
                x_inches, 4
            ),

            "y_inches": round(
                y_inches, 4
            ),

            "x_norm": round(
                x_inches / WALL_WIDTH_IN,
                6
            ),

            "y_norm": round(
                y_inches / WALL_HEIGHT_IN,
                6
            ),

            "timestamp": time.time()
        }

        try:
            self.udp.sendto(
                json.dumps(payload).encode("utf-8"),
                (UDP_HOST, UDP_PORT)
            )

        except OSError as error:
            self.status = f"UDP error: {error}"

        if kind == "touch_down":
            print(
                f"[TOUCH DOWN] ID={track_id} "
                f"X={x_inches:.2f} in "
                f"Y={y_inches:.2f} in",
                flush=True
            )

    # =================================================
    # BACKGROUND CAPTURE
    # =================================================

    def start_capture(self):
        if self.reader is None:
            return

        _, stats = self.reader.snapshot()

        if stats["age"] > 0.5:
            self.status = "LiDAR is not streaming"
            return

        self.clear_tracks()

        self.background_enabled = False
        self.background = None

        self.capture_samples.clear()

        self.capture_end = (
            time.monotonic() + CAPTURE_SECONDS
        )

        self.status = "Capturing EMPTY wall"

    def collect_background(self, scan):
        for index, angle, distance, intensity in scan:
            if not (
                MIN_RANGE <= distance <= MAX_RANGE
                and intensity >= MIN_INTENSITY
            ):
                continue

            self.capture_samples[index].append(
                distance
            )

        if time.monotonic() < self.capture_end:
            return

        self.background = {
            index: sorted(values)[
                len(values) // 2
            ]
            for index, values
            in self.capture_samples.items()
            if values
        }

        self.capture_samples.clear()
        self.capture_end = None

        self.background_enabled = True

        self.status = (
            "Background captured: "
            f"{len(self.background)} angle bins"
        )

    def is_background(self, index, distance):
        if not self.background:
            return True

        for offset in range(
            -BACKGROUND_NEIGHBORS,
            BACKGROUND_NEIGHBORS + 1
        ):
            neighbor = (
                index + offset
            ) % BIN_COUNT

            baseline = self.background.get(
                neighbor
            )

            if baseline is None:
                continue

            if abs(
                baseline - distance
            ) < BACKGROUND_DIFFERENCE:
                return True

        return False

    # =================================================
    # FOREGROUND FILTERING
    # =================================================

    def filtered_points(self, scan):
        result = []

        for index, angle, distance, intensity in scan:
            if not (
                MIN_RANGE <= distance <= MAX_RANGE
                and intensity >= MIN_INTENSITY
            ):
                continue

            x, y = self.polar_to_xy(
                angle,
                distance
            )

            if not self.in_active_area(x, y):
                continue

            if self.background_enabled:
                if self.background is None:
                    continue

                if self.is_background(
                    index,
                    distance
                ):
                    continue

            result.append((
                index,
                x,
                y
            ))

        return sorted(
            result,
            key=lambda item: item[0]
        )

    # =================================================
    # CLUSTERING
    # =================================================

    def find_clusters(self, points):
        groups = []
        current = []

        for point in points:
            if current:
                previous = current[-1]

                index_gap = (
                    point[0] - previous[0]
                )

                spatial_gap = math.hypot(
                    point[1] - previous[1],
                    point[2] - previous[2]
                )

                if (
                    index_gap > CLUSTER_INDEX_GAP
                    or spatial_gap > CLUSTER_MAX_GAP
                ):
                    groups.append(current)
                    current = []

            current.append(point)

        if current:
            groups.append(current)

        detections = []

        for group in groups:
            if not (
                MIN_CLUSTER_POINTS
                <= len(group)
                <= MAX_CLUSTER_POINTS
            ):
                continue

            center_x = sum(
                item[1] for item in group
            ) / len(group)

            center_y = sum(
                item[2] for item in group
            ) / len(group)

            detections.append((
                center_x,
                center_y
            ))

        return detections

    # =================================================
    # TOUCH TRACKING
    # =================================================

    def create_track(self, x, y):
        now = time.monotonic()

        return {
            "x": x,
            "y": y,
            "seen": now,
            "sent_x": x,
            "sent_y": y,
            "last_emit": now
        }

    def clear_tracks(self):
        for track_id, track in list(
            self.tracks.items()
        ):
            self.send_event(
                "touch_up",
                track_id,
                track["x"],
                track["y"]
            )

        self.tracks.clear()

    def track_objects(self, detections):
        now = time.monotonic()

        matched_tracks = set()

        for x, y in detections:
            closest_id = None
            closest_distance = TRACK_GATE

            for track_id, track in self.tracks.items():
                if track_id in matched_tracks:
                    continue

                distance = math.hypot(
                    track["x"] - x,
                    track["y"] - y
                )

                if distance < closest_distance:
                    closest_distance = distance
                    closest_id = track_id

            if closest_id is None:
                track_id = self.next_track_id
                self.next_track_id += 1

                self.tracks[track_id] = (
                    self.create_track(x, y)
                )

                self.send_event(
                    "touch_down",
                    track_id,
                    x,
                    y
                )

                matched_tracks.add(track_id)

            else:
                track = self.tracks[closest_id]

                track["x"] = (
                    0.85 * x +
                    0.15 * track["x"]
                )

                track["y"] = (
                    0.85 * y +
                    0.15 * track["y"]
                )

                track["seen"] = now

                movement = math.hypot(
                    track["x"] - track["sent_x"],
                    track["y"] - track["sent_y"]
                )

                if movement >= MOVE_THRESHOLD:
                    self.send_move(
                        closest_id,
                        track
                    )

                matched_tracks.add(closest_id)

        # Remove tracks no longer detected
        for track_id, track in list(
            self.tracks.items()
        ):
            if track_id in matched_tracks:
                continue

            if now - track["seen"] > TRACK_TTL:
                self.send_event(
                    "touch_up",
                    track_id,
                    track["x"],
                    track["y"]
                )

                del self.tracks[track_id]

    def send_move(self, track_id, track):
        self.send_event(
            "touch_move",
            track_id,
            track["x"],
            track["y"]
        )

        track["sent_x"] = track["x"]
        track["sent_y"] = track["y"]
        track["last_emit"] = time.monotonic()

    def heartbeat(self):
        now = time.monotonic()

        for track_id, track in self.tracks.items():
            if (
                now - track["last_emit"]
                >= HEARTBEAT
            ):
                self.send_move(
                    track_id,
                    track
                )

    # =================================================
    # MOUSE DEMO
    # =================================================

    def window_size(self):
        return (
            max(2, self.canvas.winfo_width()),
            max(2, self.canvas.winfo_height())
        )

    def mouse_position(self, event):
        width, height = self.window_size()

        x = (
            event.x / width
        ) * WALL_W

        y = (
            event.y / height
        ) * WALL_H

        return (
            max(0, min(WALL_W, x)),
            max(0, min(WALL_H, y))
        )

    def mouse_down(self, event):
        if not self.demo_mode:
            return

        x, y = self.mouse_position(event)

        if not self.in_active_area(x, y):
            return

        self.demo_pressed = True

        self.tracks[0] = (
            self.create_track(x, y)
        )

        self.send_event(
            "touch_down",
            0,
            x,
            y
        )

    def mouse_move(self, event):
        if not (
            self.demo_mode
            and self.demo_pressed
        ):
            return

        x, y = self.mouse_position(event)

        if not self.in_active_area(x, y):
            return

        track = self.tracks.get(0)

        if track is None:
            return

        track["x"] = x
        track["y"] = y
        track["seen"] = time.monotonic()

        self.send_move(0, track)

    def mouse_up(self, event):
        if not self.demo_pressed:
            return

        self.demo_pressed = False

        track = self.tracks.pop(
            0,
            None
        )

        if track:
            self.send_event(
                "touch_up",
                0,
                track["x"],
                track["y"]
            )

    # =================================================
    # KEYBOARD CONTROLS
    # =================================================

    def on_key(self, event):
        key = event.keysym.lower()

        if key == "h":
            self.show_info = not self.show_info

        elif key == "g":
            self.show_grid = not self.show_grid

        elif key == "p":
            self.show_raw = not self.show_raw

        elif key == "c":
            self.start_capture()

        elif key == "m":
            self.mirror_y = not self.mirror_y
            self.save_settings()

        elif key == "d":
            self.demo_mode = not self.demo_mode

            self.clear_tracks()
            self.demo_pressed = False

            self.status = (
                "MOUSE DEMO"
                if self.demo_mode
                else "REAL LIDAR"
            )

        elif key == "up":
            self.sensor_y = max(
                0,
                self.sensor_y - 0.5
            )

            self.save_settings()

        elif key == "down":
            self.sensor_y = min(
                WALL_HEIGHT_IN,
                self.sensor_y + 0.5
            )

            self.save_settings()

        elif key == "left":
            self.forward_angle = (
                self.forward_angle - 1
            ) % 360

            self.save_settings()

        elif key == "right":
            self.forward_angle = (
                self.forward_angle + 1
            ) % 360

            self.save_settings()

        elif key == "r":
            self.demo_mode = False
            self.connect()

        elif key == "f11":
            self.fullscreen = not self.fullscreen

            self.root.attributes(
                "-fullscreen",
                self.fullscreen
            )

        elif key == "escape":
            if self.fullscreen:
                self.fullscreen = False

                self.root.attributes(
                    "-fullscreen",
                    False
                )

    # =================================================
    # DRAW THE LIVE DETECTION MAP
    # =================================================

    def draw(self, filtered_points, raw_points):
        canvas = self.canvas

        canvas.delete("all")

        width, height = self.window_size()

        scale_x = width / WALL_W
        scale_y = height / WALL_H

        # Background
        canvas.create_rectangle(
            0, 0,
            width, height,
            fill="#10263E",
            outline=""
        )

        # Active detection area
        canvas.create_rectangle(
            ACTIVE_X0 * scale_x,
            0,
            ACTIVE_X1 * scale_x,
            height,
            fill="#123752",
            outline=""
        )

        # Dead zones
        canvas.create_rectangle(
            0, 0,
            ACTIVE_X0 * scale_x,
            height,
            fill="#62374A",
            outline=""
        )

        canvas.create_rectangle(
            ACTIVE_X1 * scale_x,
            0,
            width,
            height,
            fill="#62374A",
            outline=""
        )

        # 10 inch grid
        if self.show_grid:
            for inch in range(
                0,
                int(WALL_WIDTH_IN) + 1,
                10
            ):
                x = inch * MM * scale_x

                canvas.create_line(
                    x, 0,
                    x, height,
                    fill="#2C5B77"
                )

                canvas.create_text(
                    x + 4,
                    height - 15,
                    text=f"{inch}\"",
                    anchor="w",
                    fill="#80B4D5",
                    font=("Segoe UI", 9)
                )

            for inch in range(
                0,
                int(WALL_HEIGHT_IN) + 1,
                10
            ):
                y = inch * MM * scale_y

                canvas.create_line(
                    0, y,
                    width, y,
                    fill="#2C5B77"
                )

                canvas.create_text(
                    ACTIVE_X0 * scale_x + 6,
                    y + 9,
                    text=f"{inch}\"",
                    anchor="w",
                    fill="#80B4D5",
                    font=("Segoe UI", 9)
                )

        # Active boundaries
        for boundary in (
            ACTIVE_X0,
            ACTIVE_X1
        ):
            x = boundary * scale_x

            canvas.create_line(
                x, 0,
                x, height,
                fill="#FF8D9E",
                width=2
            )

        # Sensor position
        sensor_y_pixels = (
            self.sensor_y * MM * scale_y
        )

        canvas.create_polygon(
            0,
            sensor_y_pixels - 12,

            22,
            sensor_y_pixels,

            0,
            sensor_y_pixels + 12,

            fill="#64E8D9",
            outline=""
        )

        # Raw measurement points (optional)
        if self.show_raw:
            for index, angle, distance, intensity in raw_points:
                if not (
                    MIN_RANGE <= distance <= MAX_RANGE
                    and intensity >= MIN_INTENSITY
                ):
                    continue

                x, y = self.polar_to_xy(
                    angle,
                    distance
                )

                if not (
                    0 <= x <= WALL_W
                    and 0 <= y <= WALL_H
                ):
                    continue

                px = x * scale_x
                py = y * scale_y

                canvas.create_oval(
                    px - 1,
                    py - 1,
                    px + 1,
                    py + 1,
                    fill="#536D88",
                    outline=""
                )

        # Foreground point cloud
        for index, x, y in filtered_points:
            px = x * scale_x
            py = y * scale_y

            canvas.create_oval(
                px - 3,
                py - 3,
                px + 3,
                py + 3,
                fill="#61B4FF",
                outline=""
            )

        # Tracked objects
        for track_id, track in self.tracks.items():
            px = track["x"] * scale_x
            py = track["y"] * scale_y

            # Detection circle
            canvas.create_oval(
                px - 25,
                py - 25,
                px + 25,
                py + 25,
                outline="#4DF4E3",
                width=3
            )

            # Center marker
            canvas.create_oval(
                px - 7,
                py - 7,
                px + 7,
                py + 7,
                fill="#FFDC86",
                outline="white",
                width=2
            )

            # Crosshair
            canvas.create_line(
                px - 35, py,
                px - 12, py,
                fill="#4DF4E3",
                width=2
            )

            canvas.create_line(
                px + 12, py,
                px + 35, py,
                fill="#4DF4E3",
                width=2
            )

            canvas.create_line(
                px, py - 35,
                px, py - 12,
                fill="#4DF4E3",
                width=2
            )

            canvas.create_line(
                px, py + 12,
                px, py + 35,
                fill="#4DF4E3",
                width=2
            )

            # Coordinates
            text_x = min(
                width - 170,
                px + 40
            )

            text_y = max(
                25,
                py - 28
            )

            canvas.create_text(
                text_x,
                text_y,
                text=(
                    f"ID {track_id} | "
                    f"{track['x'] / MM:.1f}\", "
                    f"{track['y'] / MM:.1f}\""
                ),
                anchor="w",
                fill="#FFE49D",
                font=("Segoe UI", 11, "bold")
            )

        # Status panel
        if self.show_info:
            lines = [
                f"LD19 STATUS: {self.status}",
                (
                    f"Packets: {self.last_stats.get('valid', 0)}"
                    f" | CRC errors: {self.last_stats.get('bad', 0)}"
                    f" | RPM: {self.last_stats.get('rpm', 0):.1f}"
                ),
                (
                    f"Foreground points: {len(filtered_points)}"
                    f" | Active tracks: {len(self.tracks)}"
                ),
                (
                    f"Sensor Y: {self.sensor_y:.1f} in"
                    f" | Forward angle: {self.forward_angle:.0f}°"
                    f" | Mirror: {self.mirror_y}"
                ),
                (
                    f"Mode: {'MOUSE DEMO' if self.demo_mode else 'REAL LIDAR'}"
                    f" | UDP: {UDP_HOST}:{UDP_PORT}"
                ),
                (
                    "H info | G grid | P raw | C capture | "
                    "M mirror | D demo | R reconnect"
                ),
                (
                    "Arrow keys: sensor/angle | "
                    "F11 fullscreen | Esc exit fullscreen"
                )
            ]

            panel_width = min(
                width - 20,
                1050
            )

            panel_height = len(lines) * 22 + 18

            canvas.create_rectangle(
                10, 10,
                10 + panel_width,
                10 + panel_height,
                fill="#071A2E",
                outline="#416A86"
            )

            for i, line in enumerate(lines):
                canvas.create_text(
                    22,
                    25 + i * 22,
                    text=line,
                    anchor="w",
                    fill="#E7F2FA",
                    font=("Consolas", 10)
                )

        # Capture notification
        if self.capture_end is not None:
            canvas.create_text(
                width / 2,
                height - 50,
                text="CAPTURING BACKGROUND — KEEP WALL EMPTY",
                fill="#FFDB8A",
                font=("Segoe UI", 18, "bold")
            )

    # =================================================
    # MAIN UPDATE LOOP
    # =================================================

    def tick(self):
        if self.demo_mode:
            self.heartbeat()
            self.draw([], [])
        else:
            scan, stats = self.reader.snapshot()

            self.last_stats = stats

            now = time.monotonic()

            # Automatic empty-wall capture
            if (
                not self.auto_capture_done
                and stats["valid"] >= 50
                and stats["age"] < 0.5
                and self.capture_end is None
            ):
                if self.first_live is None:
                    self.first_live = now
                    self.status = (
                        "Sensor connected - keep wall empty"
                    )

                elif (
                    now - self.first_live
                    >= AUTO_CAPTURE_DELAY
                ):
                    self.auto_capture_done = True
                    self.start_capture()

            if self.capture_end is not None:
                self.collect_background(scan)

            points = self.filtered_points(scan)
            self.last_points = points

            if (
                self.background_enabled
                and self.background is not None
                and self.capture_end is None
                and stats["age"] < 0.5
            ):
                detections = self.find_clusters(
                    points
                )

                self.track_objects(detections)
                self.heartbeat()

            else:
                self.clear_tracks()

            if stats["error"]:
                self.status = (
                    "ERROR: " + stats["error"]
                )

            elif self.capture_end is not None:
                self.status = (
                    "Capturing empty-wall baseline"
                )

            elif stats["age"] < 0.5:
                if self.background_enabled:
                    self.status = "LIVE - " + PORT

            else:
                self.status = (
                    "Waiting for LiDAR data"
                )

            self.draw(
                points,
                scan
            )

        self.root.after(
            20,
            self.tick
        )

    # =================================================
    # SHUTDOWN
    # =================================================

    def close(self):
        self.clear_tracks()

        if self.reader:
            self.reader.close()

        self.udp.close()
        self.root.destroy()


# =====================================================
# START APPLICATION
# =====================================================

if __name__ == "__main__":
    print("=" * 60)
    print("OLYMPIC ARCHERY - LD19 LIVE DETECTION MAP")
    print("=" * 60)

    print(f"Port: {PORT}")
    print(f"Baud: {BAUD}")
    print(
        f"Wall: {WALL_WIDTH_IN} x "
        f"{WALL_HEIGHT_IN} inches"
    )
    print(
        f"Active area: "
        f"{WALL_WIDTH_IN - DEAD_LEFT_IN - DEAD_RIGHT_IN} inches"
    )
    print(f"UDP: {UDP_HOST}:{UDP_PORT}")
    print()
    print("Keep the wall empty during calibration.")
    print()

    root = tk.Tk()

    app = LidarStudio(root)

    root.mainloop()