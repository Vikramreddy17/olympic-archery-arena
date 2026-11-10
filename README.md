# 🎯 Olympic Archery Arena

<p align="center">
  <img src="docs/screenshots/01_welcome_hero.svg" alt="Olympic Archery Arena Banner" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/Vikramreddy17/olympic-archery-arena/actions"><img src="https://github.com/Vikramreddy17/olympic-archery-arena/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
  <a href="#-features"><img src="https://img.shields.io/badge/Platform-Web%20%7C%20Interactive%20Wall-008ecc?style=for-the-badge" alt="Platform" /></a>
  <a href="#-hardware--lidar-integration"><img src="https://img.shields.io/badge/Hardware-LD19%20LiDAR%20Laser-f7cc73?style=for-the-badge&logoColor=black" alt="Hardware" /></a>
  <a href="https://flask.palletsprojects.com/"><img src="https://img.shields.io/badge/Backend-Flask%203.x-black?style=for-the-badge&logo=flask" alt="Backend" /></a>
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Database-SQLite%20WAL-003B57?style=for-the-badge&logo=sqlite" alt="Database" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License" /></a>
</p>

---

## 📖 Overview

**Olympic Archery Arena** is a full-featured, stadium-style interactive archery simulation and sports entertainment system. Built for both **standard browser/touchscreen play** and **large-scale interactive projection walls** (e.g., 149" × 80" physical target surfaces), it bridges web technologies with physical hardware tracking.

The system features real-time projectile/touch detection using an **LD19 LiDAR sensor**, procedural synthesizer audio, dynamic camera transitions, responsive canvas geometry without letterboxing, and an Olympic-grade scoring engine with a persistent SQLite Hall of Fame.

---

## ✨ Features

- 🏹 **Authentic Olympic Scoring Rules**:
  - **3 Targets · 12 Arrows Total** (4 arrows per target).
  - **Best 3 Count**: The lowest shot on each target is dropped, scoring a maximum of 90 points.
  - **10-Second Shot Clock**: Enforces tournament pressure with visual timers and auditory warning ticks.
  - **3-Second Staged Countdown**: Seamless target transitions with countdown announcements.
- ⚡ **Dual Input Modes**:
  - **Standalone Mode**: Play immediately in any modern web browser via mouse, trackpad, or touchscreen.
  - **Interactive Wall Mode**: Connect an **LD19 LiDAR sensor** over USB/Serial to detect real ball throws, suction arrows, or hand touches across a projected wall.
- 📐 **Full-Width Adaptive Canvas (No Black Bars)**:
  - Custom geometric engine maintains true circular targets across any viewport or projector aspect ratio without letterboxing or distortion.
- 🎵 **Built-In Procedural Web Audio Engine**:
  - Synthesizes bow releases, arrow whooshes, target impacts, countdown beeps, crowd ambience, and a gold-medal fanfare purely in code (no external MP3/WAV downloads required).
- 🏆 **Persistent Hall of Fame Leaderboard**:
  - Powered by SQLite with Write-Ahead Logging (WAL) for concurrency.
  - Real-time ranking with tie-breakers (Total Score ➜ Perfect 10s ➜ Accuracy % ➜ Timestamp).
  - Filterable by difficulty: **Rookie (Easy)**, **Contender (Medium)**, and **Champion (Hard)**.
- 🛡️ **Operator Controls & Calibration**:
  - PIN-protected admin modal (`ARCHERY_ADMIN_PIN`) for resetting leaderboard records.
  - Interactive LiDAR calibration grid toggle directly on the stadium canvas.

---

## 📊 Detailed System & Architecture Diagrams

### 1. Overall System Architecture & Data Pipeline
The diagram below illustrates how raw laser measurements from the physical LiDAR hardware pass through mathematical filtering, clustering, and UDP delivery into the Flask API and HTML5 Canvas frontend.

```mermaid
flowchart TD
    subgraph Physical Installation ["🏟️ Physical Projection Wall Environment"]
        LIDAR["📡 LD19 LiDAR Sensor<br/>(COM Port / 230,400 baud)"]
        PROJ["📽️ Projector Wall<br/>(149 in × 80 in Active Field)"]
        ATHLETE["🏹 Athlete / Projectile Impact"]
    end

    subgraph Hardware Layer ["🐍 Python Sensor Engine (lidar_ld19.py)"]
        PARSE["CRC8 Validator & Packet Parser"]
        BG["Adaptive Background Subtraction"]
        CLUSTER["DBSCAN Cluster Centroid Tracker"]
        COORD["Coordinate Normalizer (0.0 to 1.0)"]
    end

    subgraph Server Layer ["🌐 Flask Web Server (app.py)"]
        UDP["UDP Socket Listener (Port 5005)"]
        RING["Thread-Safe In-Memory Ring Buffer"]
        API["JSON REST API Endpoints (/api/...)"]
        DB[(🗄️ SQLite Database: archery.db)]
    end

    subgraph Client Layer ["💻 Browser Frontend (HTML5 Canvas + Web Audio)"]
        POLL["Real-Time Event Poller (/api/input-events)"]
        STAGE["Adaptive Canvas Renderer (game.js)"]
        AUDIO["Web Audio Procedural Synthesizer"]
        FALLBACK["Direct Mouse / Touch Input Fallback"]
    end

    ATHLETE -->|Crosses Laser Plane| LIDAR
    LIDAR -->|Raw 47-Byte Telemetry Packets| PARSE
    PARSE --> BG --> CLUSTER --> COORD
    COORD -->|JSON Datagrams via UDP| UDP
    UDP --> RING --> API
    API <-->|REST Polling & Score Submission| POLL
    POLL --> STAGE
    FALLBACK --> STAGE
    STAGE --> AUDIO
    STAGE -.->|Rendered & Projected onto| PROJ
    API <-->|Score Storage & Leaderboard Queries| DB
```

---

### 2. Tournament Lifecycle & Gameplay State Machine
From the welcome screen to difficulty selection, practice rounds, live tournament scoring, and podium celebrations:

```mermaid
stateDiagram-v2
    [*] --> WelcomeScreen: Application Launch
    
    WelcomeScreen --> AthleteRegistration: Click "Start Challenge"
    WelcomeScreen --> HallOfFame: Click "Hall of Fame"
    
    AthleteRegistration --> DifficultySelection: Enter Valid Name (1-24 chars)
    DifficultySelection --> PracticeMode: Select Rookie / Contender / Champion
    
    state PracticeMode {
        [*] --> PracticeTarget
        PracticeTarget --> PracticeFeedback: 3 Warm-Up Shots
        PracticeFeedback --> [*]: Ready for Tournament
    }
    
    PracticeMode --> Target1: Start Official Match
    
    state TournamentMatch {
        state "Target 1 (Left Active)" as Target1 {
            [*] --> T1_Countdown: 3-Second Ready Count
            T1_Countdown --> T1_Live: 10s Timer per Shot
            T1_Live --> T1_Live: Record 4 Shots
            T1_Live --> [*]: Best 3 Counted
        }
        
        state "Target 2 (Center Active)" as Target2 {
            [*] --> T2_Countdown: 3-Second Ready Count
            T2_Countdown --> T2_Live: 10s Timer per Shot
            T2_Live --> T2_Live: Record 4 Shots
            T2_Live --> [*]: Best 3 Counted
        }
        
        state "Target 3 (Right Active)" as Target3 {
            [*] --> T3_Countdown: 3-Second Ready Count
            T3_Countdown --> T3_Live: 10s Timer per Shot
            T3_Live --> T3_Live: Record 4 Shots
            T3_Live --> [*]: Best 3 Counted
        }
        
        Target1 --> Target2: Smooth Camera & Target Layout Transition
        Target2 --> Target3: Smooth Camera & Target Layout Transition
    }
    
    Target3 --> OlympicScoringEngine: 12 Shots Complete
    
    state OlympicScoringEngine {
        [*] --> DropLowest: Drop Lowest Shot per Target
        DropLowest --> SumBestNine: Sum Best 3 per Target (Max 90 Pts)
        SumBestNine --> AccuracyCalc: Calculate Hit Rate & 10s Count
        AccuracyCalc --> [*]
    }
    
    OlympicScoringEngine --> PodiumResults: POST /api/score
    PodiumResults --> HallOfFame: View Global Standings
    PodiumResults --> WelcomeScreen: Play Again
    HallOfFame --> WelcomeScreen: Back to Stadium
```

---

### 3. Shot Impact Detection & Low-Latency Event Sequence
How an arrow impact is detected, parsed, mapped to target rings, scored, and accompanied by procedural audio in under 20 milliseconds:

```mermaid
sequenceDiagram
    autonumber
    actor Athlete as 🏹 Athlete / Projectile
    participant Wall as 📽️ Projection Wall (149" × 80")
    participant LiDAR as 📡 LD19 LiDAR Sensor (COM7)
    participant Driver as 🐍 Python Driver (lidar_ld19.py)
    participant Server as 🌐 Flask App (app.py :5005)
    participant Client as 🎯 Game Client (game.js)
    participant Synth as 🔊 Web Audio Synthesizer

    Athlete->>Wall: Arrow hits target ring
    Wall-->>LiDAR: Projectile intersects 360° laser sweep
    LiDAR->>Driver: Transmit 47-byte serial data @ 230,400 baud
    Driver->>Driver: Verify CRC8 checksum & filter static background
    Driver->>Driver: Calculate cluster centroid & normalize coordinates (0.0 - 1.0)
    Driver->>Server: UDP Datagram: {"type": "down", "x_norm": 0.502, "y_norm": 0.498}
    Server->>Server: Sequence packet & insert into thread-safe buffer
    Client->>Server: GET /api/input-events?after=seq
    Server-->>Client: 200 OK [{"seq": 104, "x": 0.502, "y": 0.498}]
    Client->>Client: Transform normalized coords into dynamic stage pixels
    Client->>Client: Calculate distance to active target center (Score 10, 9, 8... 0)
    par Visual & Audio Feedback
        Client->>Synth: Trigger procedural hit sound & bullseye fanfare
        Client->>Client: Render arrow puncture, ripple rings & score popup (+10)
    end
    Client->>Client: Update Live HUD Score & Target Slots (Best 3 of 4)
```

---

### 4. Interactive Wall & LiDAR Physical Calibration Geometry
The coordinate transformation pipeline maps physical inches into normalized unit floats and then into responsive canvas coordinates:

```text
  +---------------------------------------------------------------------------------+
  |<-- 4" -->|                          141" ACTIVE ZONE                 |<-- 4" -->|
  | Deadzone |                                                           | Deadzone |
  | (Left)   |                                                           | (Right)  |
  +----------+-----------------------------------------------------------+----------+ (Y = 80" Top)
  |          |                                                           |          |
  |          |        [Target 1]             [Target 2]        [Target 3]|          |
  |          |                                (Active)                   |          |
  |          |                                                           |          |
  |          |                        · (X_norm, Y_norm)                 |          |
  |          |                          Impact Point                     |          |
  |          |                                                           |          |
  |          |================== Laser Scan Sweep Line ==================|          | (Y = 38" Sensor)
  |          |                            📡                             |          |
  |          |                     LD19 LiDAR (COM7)                     |          |
  +----------+-----------------------------------------------------------+----------+ (Y = 0" Floor)
  |<---------------------------------- 149" --------------------------------------->|
```

| Parameter | Physical Value | Metric Value | Normalized Range | Description |
|---|---|---|---|---|
| **Wall Width** | `149.0 inches` | `3784.6 mm` | `0.00` to `1.00` | Full physical projection width |
| **Wall Height** | `80.0 inches` | `2032.0 mm` | `0.00` to `1.00` | Full physical projection height |
| **Dead Zones** | `4.0 inches` each | `101.6 mm` | `x < 0.027`, `x > 0.973` | Margins ignored to prevent frame reflections |
| **Active Width** | `141.0 inches` | `3581.4 mm` | Active scoring area | Usable projectile detection plane |
| **LiDAR Height** | `38.0 inches` | `965.2 mm` | Center baseline | Default physical sensor elevation from floor |
| **Viewer PPI** | `10 px / inch` | — | `1490 × 800 px` | Internal calibration viewer resolution |

---

### 5. Database Entity Relationship Diagram (SQLite WAL)
The database tracks individual athlete sessions, detailed round-by-round shot telemetry, and leaderboard rankings:

```mermaid
erDiagram
    SCORES {
        integer id PK "Primary key (AUTOINCREMENT)"
        string player "Athlete name (1 to 24 chars)"
        string level "Difficulty: easy | medium | hard"
        integer total "Best 3 of 4 shots per target (0 to 90)"
        float accuracy "Hit percentage (0.0 to 100.0%)"
        integer tens "Count of perfect 10-ring bullseyes"
        string shots_json "Full 3x4 round shots array in JSON"
        string created_at "ISO-8601 UTC timestamp"
    }
```

#### Database Schema & Indexes

```sql
CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player TEXT NOT NULL,
    level TEXT NOT NULL,
    total INTEGER NOT NULL,
    accuracy REAL NOT NULL,
    tens INTEGER NOT NULL,
    shots_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Fast leaderboard sorting index
CREATE INDEX IF NOT EXISTS idx_scores 
ON scores (level, total DESC, tens DESC);
```

---

## 📸 Interface Showcase

### 1. Stadium Hero & Registration
> The tournament landing screen featuring difficulty selection (Rookie, Contender, Champion), practice mode, and session setup.
![Hero Screen](docs/screenshots/01_welcome_hero.svg)

---

### 2. Live Olympic Target Range
> Full-screen stadium canvas with dynamic target transitions, 10-second shot timer, arrow impact markers, and real-time shot trackers.
![Gameplay Arena](docs/screenshots/02_gameplay_arena.svg)

---

### 3. Hall of Fame & Leaderboard
> Real-time ranking with difficulty filters, hit-rate statistics, timestamped records, and operator reset security.
![Hall of Fame](docs/screenshots/03_leaderboard_hall.svg)

---

## 📂 Project Structure

```text
olympic_archery/
├── app.py                   # Flask server, REST API, SQLite database & UDP receiver
├── lidar_ld19.py            # LD19 LiDAR driver, background subtractor & calibration UI
├── requirements.txt         # Python dependencies (Flask, pyserial)
├── archery.db               # SQLite database file (auto-initialized on first run)
├── .env.example             # Template for configuration & admin security PIN
├── .gitignore               # Clean ignore list (virtual environments, databases, cache)
├── LICENSE                  # MIT Open Source License
├── README.md                # Project documentation with detailed diagrams
│
├── static/
│   ├── game.js              # Complete stadium simulation, canvas renderer & audio engine
│   └── style.css            # Dark athletic arena styling, HUD, modals & animations
│
├── templates/
│   └── index.html           # Single-page application structure & operator modals
│
├── scripts/
│   ├── setup.bat            # One-click Windows virtual environment installer
│   ├── run_arena.bat        # Launch the Flask web game server
│   └── run_lidar.bat        # Launch the LD19 LiDAR tracking controller
│
└── docs/
    └── screenshots/         # UI previews, diagrams and visual assets
```

---

## 🚀 Quick Start Guide

### Prerequisites
- **Python 3.10+** installed and added to your system `PATH`.
- A modern web browser (Google Chrome, Microsoft Edge, Firefox, or Safari).

---

### Option A: Quick Launch on Windows (Using Scripts)

1. **Install dependencies**:
   Double-click `scripts\setup.bat` (or run it from PowerShell/CMD).
2. **Start the Web Game**:
   Double-click `scripts\run_arena.bat`.
3. **Open the Arena**:
   Navigate to [http://localhost:5000](http://localhost:5000) in your browser.

---

### Option B: Manual Setup (Cross-Platform: Windows, macOS, Linux)

1. **Clone or navigate to the repository**:
   ```bash
   git clone https://github.com/Vikramreddy17/olympic-archery-arena.git
   cd olympic-archery-arena
   ```

2. **Create and activate a virtual environment**:
   - **Windows (PowerShell)**:
     ```powershell
     python -m venv .venv
     .\.venv\Scripts\Activate.ps1
     ```
   - **macOS / Linux**:
     ```bash
     python3 -m venv .venv
     source .venv/bin/activate
     ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Launch the Flask application**:
   ```bash
   python app.py
   ```

5. **Play**: Open `http://localhost:5000` in your web browser. Press **F11** for an immersive full-screen experience!

---

## 📡 Hardware & LiDAR Integration (Optional)

To convert any flat wall into a massive interactive target using an **LD19 360° LiDAR**:

1. **Mounting**: Place the LD19 LiDAR sensor centered at the base or top of your projected area (default `Y = 38"` above floor level).
2. **Configure LiDAR Settings**:
   Open `lidar_ld19.py` and adjust the serial port for your system (e.g., `PORT = "COM7"` on Windows or `PORT = "/dev/ttyUSB0"` on Linux).
3. **Run the LiDAR Controller**:
   ```bash
   python lidar_ld19.py
   ```
4. **Calibrate**:
   - Use the Tkinter calibration window to capture the background wall profile (press `Capture Background`).
   - Open the web interface at `http://localhost:5000`, click **⚙ Operator**, and check **Enable LD19 Input**.
   - Throw a soft ball, shoot suction arrows, or tap the wall to trigger instant on-screen impacts!

---

## ⚙️ Configuration & Environment Variables

You can configure the application using environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `ARCHERY_ADMIN_PIN` | `2468` | Operator PIN required to reset the Hall of Fame records |
| `ARCHERY_LIDAR` | `0` | Set to `1` to run the embedded UDP receiver inside the Flask process |
| `PORT` | `5000` | Port for the web application server |
| `FLASK_ENV` | `production` | Running environment mode (`development` / `production`) |

---

## 📡 REST API Reference

The backend exposes a JSON REST API:

### `GET /api/leaderboard`
Retrieve ranked leaderboard scores.
- **Parameters**: `level` (`all`, `easy`, `medium`, `hard`)
- **Response**:
  ```json
  {
    "entries": [
      {
        "id": 1,
        "player": "Robin_Hood",
        "level": "hard",
        "total": 90,
        "accuracy": 100.0,
        "tens": 9,
        "created_at": "2026-11-10T15:00:00+00:00"
      }
    ],
    "sessions": 248
  }
  ```

### `POST /api/score`
Submit scores upon completion of 3 targets.
- **Body**:
  ```json
  {
    "player": "ArcherX",
    "level": "medium",
    "rounds": [
      [10, 10, 9, 8],
      [10, 9, 9, 7],
      [10, 10, 10, 8]
    ]
  }
  ```

### `GET /api/input-events`
Fetch real-time LiDAR hit events for low-latency web synchronization.
- **Parameters**: `after` (sequence number)

### `POST /api/admin/reset`
Wipe the Hall of Fame database (protected by operator PIN).
- **Body**: `{"pin": "2468"}`

---

## 🎯 Scoring & Difficulty Levels

| Difficulty | Target Size | Challenge Profile | Scoring Rule |
|---|---|---|---|
| **Rookie (Easy)** | Radius: 184px | Beginner athletes, casual events, younger players | Best 3 of 4 shots count per target |
| **Contender (Medium)** | Radius: 174px | Standard competition, balanced hit windows | Best 3 of 4 shots count per target |
| **Champion (Hard)** | Radius: 162px | Precision tournament target for elite marksmen | Best 3 of 4 shots count per target |

- **Rings**: Gold (10 / 9), Red (8 / 7), Blue (6 / 5), Black (4 / 3), White (2 / 1), Miss (0).
- **Maximum Possible Score**: 90 points (3 targets × 30 max points per target).

---

## 🛠️ Troubleshooting

- **No sound playing?**
  Click the **♫ SOUND** button in the top navigation bar. Browsers require a user interaction before allowing audio playback.
- **LiDAR COM port error?**
  Verify your device is plugged in via Device Manager (Windows) and update `PORT = "COM..."` in `lidar_ld19.py`.
- **Fullscreen mode?**
  Click **⛶ Fullscreen** in the navigation bar or press `F11` in your browser.

---

## 📄 License

This project is open-source under the [MIT License](LICENSE). You are free to use, modify, and distribute it for personal, educational, or commercial installations.
