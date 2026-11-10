import json
import os
import socket
import sqlite3
import threading
import time

from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "archery.db"

ADMIN_PIN = os.environ.get(
    "ARCHERY_ADMIN_PIN",
    "2468"
)

app = Flask(__name__)
app.json.sort_keys = False

LEVELS = {"easy", "medium", "hard"}

lidar_events = deque(maxlen=300)
lidar_lock = threading.Lock()
lidar_sequence = 0


# ======================================
# DATABASE
# ======================================

def get_db():
    db = sqlite3.connect(
        DB_PATH,
        timeout=10
    )

    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")

    return db


def init_database():
    with get_db() as db:

        db.execute("PRAGMA journal_mode=WAL")

        db.execute("""
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player TEXT NOT NULL,
                level TEXT NOT NULL,
                total INTEGER NOT NULL,
                accuracy REAL NOT NULL,
                tens INTEGER NOT NULL,
                shots_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_scores
            ON scores (
                level,
                total DESC,
                tens DESC
            )
        """)


def score_to_dict(row):
    return {
        "id": row["id"],
        "player": row["player"],
        "level": row["level"],
        "total": row["total"],
        "accuracy": row["accuracy"],
        "tens": row["tens"],
        "created_at": row["created_at"]
    }


# ======================================
# HOME
# ======================================

@app.get("/")
def home():
    return render_template("index.html")


# ======================================
# LEADERBOARD
# ======================================

@app.get("/api/leaderboard")
def leaderboard():

    level = request.args.get(
        "level",
        "all"
    ).lower()

    if level not in LEVELS | {"all"}:
        return jsonify(
            error="Invalid difficulty"
        ), 400

    with get_db() as db:

        if level == "all":

            rows = db.execute("""
                SELECT *
                FROM scores
                ORDER BY
                    total DESC,
                    tens DESC,
                    accuracy DESC,
                    id ASC
                LIMIT 100
            """).fetchall()

        else:

            rows = db.execute("""
                SELECT *
                FROM scores
                WHERE level = ?
                ORDER BY
                    total DESC,
                    tens DESC,
                    accuracy DESC,
                    id ASC
                LIMIT 100
            """, (level,)).fetchall()

        sessions = db.execute("""
            SELECT COUNT(*)
            FROM scores
        """).fetchone()[0]

    return jsonify({
        "entries": [
            score_to_dict(row)
            for row in rows
        ],
        "sessions": sessions
    })


# ======================================
# SAVE SCORE
# ======================================

@app.post("/api/score")
def save_score():

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify(
            error="Invalid JSON"
        ), 400

    player = data.get("player")
    level = data.get("level")
    rounds = data.get("rounds")

    if (
        not isinstance(player, str)
        or not 1 <= len(player.strip()) <= 24
    ):
        return jsonify(
            error="Invalid player name"
        ), 400

    if level not in LEVELS:
        return jsonify(
            error="Invalid difficulty"
        ), 400

    if not isinstance(rounds, list):
        return jsonify(
            error="Invalid rounds"
        ), 400

    if len(rounds) != 3:
        return jsonify(
            error="Exactly 3 rounds required"
        ), 400

    for round_scores in rounds:

        if not isinstance(round_scores, list):
            return jsonify(
                error="Invalid round data"
            ), 400

        if len(round_scores) != 4:
            return jsonify(
                error="Each target requires 4 shots"
            ), 400

        for value in round_scores:

            if (
                type(value) is not int
                or value < 0
                or value > 10
            ):
                return jsonify(
                    error="Scores must be 0 to 10"
                ), 400

    # Best 3 from each target
    total = sum(
        sum(
            sorted(round_scores, reverse=True)[:3]
        )
        for round_scores in rounds
    )

    all_shots = [
        value
        for round_scores in rounds
        for value in round_scores
    ]

    hits = sum(
        score > 0
        for score in all_shots
    )

    accuracy = round(
        hits / 12 * 100,
        1
    )

    tens = all_shots.count(10)

    created_at = datetime.now(
        timezone.utc
    ).isoformat(timespec="seconds")

    with get_db() as db:

        cursor = db.execute("""
            INSERT INTO scores (
                player,
                level,
                total,
                accuracy,
                tens,
                shots_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            player.strip(),
            level,
            total,
            accuracy,
            tens,
            json.dumps(rounds),
            created_at
        ))

        score_id = cursor.lastrowid

        rank = db.execute("""
            SELECT COUNT(*) + 1
            FROM scores
            WHERE level = ?
            AND (
                total > ?
                OR (
                    total = ?
                    AND tens > ?
                )
                OR (
                    total = ?
                    AND tens = ?
                    AND accuracy > ?
                )
                OR (
                    total = ?
                    AND tens = ?
                    AND accuracy = ?
                    AND id < ?
                )
            )
        """, (
            level,
            total,
            total, tens,
            total, tens, accuracy,
            total, tens, accuracy, score_id
        )).fetchone()[0]

    return jsonify({
        "ok": True,
        "id": score_id,
        "total": total,
        "accuracy": accuracy,
        "tens": tens,
        "rank": rank
    }), 201


# ======================================
# RESET HALL OF FAME
# ======================================

@app.post("/api/admin/reset")
def reset_leaderboard():

    data = request.get_json(silent=True) or {}

    pin = str(data.get("pin", ""))

    if pin != ADMIN_PIN:
        return jsonify(
            error="Incorrect operator PIN"
        ), 403

    with get_db() as db:

        deleted = db.execute("""
            DELETE FROM scores
        """).rowcount

    return jsonify({
        "ok": True,
        "deleted": deleted
    })


# ======================================
# LIDAR UDP RECEIVER
# ======================================

def lidar_udp_receiver():

    global lidar_sequence

    sock = socket.socket(
        socket.AF_INET,
        socket.SOCK_DGRAM
    )

    try:
        sock.bind((
            "127.0.0.1",
            5005
        ))

    except OSError as error:
        print("[LiDAR] Cannot bind:", error)
        return

    print("[LiDAR] Listening on UDP 5005")

    while True:

        try:
            packet, _ = sock.recvfrom(4096)

            data = json.loads(
                packet.decode("utf-8")
            )

            if not isinstance(data, dict):
                continue

            event_type = data.get("type")

            if event_type not in (
                "touch_down",
                "touch_move",
                "down"
            ):
                continue

            if (
                "x_inches" in data
                and "y_inches" in data
            ):

                x = float(
                    data["x_inches"]
                ) / 149.0

                y = float(
                    data["y_inches"]
                ) / 80.0

            else:

                x = float(data["x_norm"])
                y = float(data["y_norm"])

            if not (
                0 <= x <= 1
                and 0 <= y <= 1
            ):
                continue

            with lidar_lock:

                lidar_sequence += 1

                lidar_events.append({
                    "seq": lidar_sequence,
                    "type": event_type,
                    "x": x,
                    "y": y,
                    "received": time.monotonic()
                })

        except (
            ValueError,
            KeyError,
            TypeError,
            UnicodeDecodeError
        ):
            continue

        except OSError:
            break


# ======================================
# LIDAR EVENT API
# ======================================

@app.get("/api/input-events")
def input_events():

    try:
        after = max(
            0,
            int(
                request.args.get("after", "0")
            )
        )

    except ValueError:
        return jsonify(
            error="Invalid sequence"
        ), 400

    with lidar_lock:

        current_seq = lidar_sequence

        events = []

        for event in lidar_events:

            if event["seq"] <= after:
                continue

            if (
                time.monotonic()
                - event["received"]
                > 2
            ):
                continue

            events.append({
                "seq": event["seq"],
                "type": event["type"],
                "x": event["x"],
                "y": event["y"]
            })

    return jsonify({
        "seq": current_seq,
        "events": events
    })


# ======================================
# RUN
# ======================================

init_database()

if __name__ == "__main__":

    if os.environ.get(
        "ARCHERY_LIDAR",
        "0"
    ) == "1":

        threading.Thread(
            target=lidar_udp_receiver,
            daemon=True
        ).start()

    print()
    print("=" * 55)
    print("OLYMPIC ARCHERY ARENA")
    print("=" * 55)
    print("Game: http://localhost:5000")
    print("Timer: 10 seconds for every scoring shot")
    print("Countdown: 3 seconds per target")
    print("=" * 55)

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
        threaded=True
    )