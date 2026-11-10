"use strict";

// =======================================================
// OLYMPIC ARCHERY ARENA
// FULL-WIDTH STADIUM — NO BLACK SIDE AREAS
// =======================================================

const $ = id => document.getElementById(id);

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;

const SHOT_SECONDS = 10;
const FEEDBACK_MS = 1050;
const RESULTS_MS = 6000;
const HALL_MS = 5000;
const TRANSITION_MS = 850;

// Active target is large; others are smaller.
const LEVELS = {
  easy: { radius: 184 },
  medium: { radius: 174 },
  hard: { radius: 162 }
};

const SMALL_RADIUS = 76;

// Target positions inside the central 1280px stage.
const LAYOUTS = [
  // Target 1 active
  [
    { x: 344, y: 346, scale: 1 },
    { x: 802, y: 290, scale: 0.44 },
    { x: 1102, y: 288, scale: 0.44 }
  ],

  // Target 2 active
  [
    { x: 174, y: 288, scale: 0.44 },
    { x: 640, y: 346, scale: 1 },
    { x: 1106, y: 288, scale: 0.44 }
  ],

  // Target 3 active
  [
    { x: 178, y: 288, scale: 0.44 },
    { x: 478, y: 290, scale: 0.44 },
    { x: 936, y: 346, scale: 1 }
  ]
];

const canvas = $("arena");
const ctx = canvas.getContext("2d");

// Canvas height is fixed in logical units.
// Width changes with the real displayed aspect ratio.
let viewWidth = BASE_WIDTH;
let viewHeight = BASE_HEIGHT;
let stageScale = 1;
let stageOffset = 0;

const state = {
  screen: "Welcome",
  previousScreen: "Welcome",

  player: "",
  level: "medium",
  phase: "practice",

  round: 0,
  practiceShots: 0,
  rounds: [[], [], []],
  hits: [],

  locked: true,
  deadline: 0,
  submitted: false,

  lidar: false,
  calibration: false,
  lidarSeq: 0,
  lastLidarAt: 0,
  lidarMarker: null,

  cycleId: 0,
  countdownId: 0,
  selectedFilter: "all",

  currentLayout: [],
  fromLayout: [],
  targetLayout: [],
  transitionStart: 0,
  transitioning: false
};

const timers = new Set();

let visualPulse = 0;
let lidarRequestActive = false;
let lidarGeneration = 0;
let leaderboardRequestId = 0;


// =======================================================
// HELPERS
// =======================================================

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function schedule(callback, milliseconds) {
  const id = setTimeout(() => {
    timers.delete(id);
    callback();
  }, milliseconds);

  timers.add(id);
  return id;
}

function cancelTimers() {
  state.cycleId++;
  state.countdownId++;
  state.locked = true;
  state.deadline = 0;

  for (const id of timers) {
    clearTimeout(id);
  }

  timers.clear();

  $("countdown").classList.add("hidden");
  $("shotPopup").classList.add("hidden");
  $("gameOverlay").classList.add("hidden");
}

function scoreRound(shots) {
  return shots.slice()
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, score) => sum + score, 0);
}

function totalScore() {
  return state.rounds.reduce((sum, round) => {
    return round.length === 4
      ? sum + scoreRound(round)
      : sum;
  }, 0);
}

function showScreen(name) {
  state.screen = name;

  [
    "Welcome",
    "Name",
    "Level",
    "Game",
    "Results",
    "Hall"
  ].forEach(screen => {
    $("screen" + screen).classList.toggle(
      "hidden",
      screen !== name
    );
  });

  requestAnimationFrame(resizeCanvas);
}

function toast(message, error = false) {
  const el = $("toast");

  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.remove("hidden");

  setTimeout(() => {
    if (el.textContent === message) {
      el.classList.add("hidden");
    }
  }, 2800);
}


// =======================================================
// FULL-WIDTH CANVAS
//
// No letterboxing.
// No horizontal oval targets.
//
// The canvas backing size follows the actual viewport
// ratio, while retaining a 720-unit logical height.
//
// Extra width is allocated to the stadium environment.
// =======================================================

function resizeCanvas() {
  const wrapper = $("arenaWrap");

  if (!wrapper) return;

  const rect = wrapper.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  // Subtract borders via client dimensions.
  const displayWidth = wrapper.clientWidth;
  const displayHeight = wrapper.clientHeight;

  if (displayWidth <= 0 || displayHeight <= 0) {
    return;
  }

  // Maintain equal X/Y scaling.
  const nextWidth = Math.max(
    1,
    Math.round(
      BASE_HEIGHT * displayWidth / displayHeight
    )
  );

  viewWidth = nextWidth;
  viewHeight = BASE_HEIGHT;

  // Fit target geometry when the screen is narrower
  // than the original 1280px game stage.
  stageScale = Math.min(
    1,
    viewWidth / BASE_WIDTH
  );

  stageOffset =
    (viewWidth - BASE_WIDTH * stageScale) / 2;

  // Setting canvas dimensions resets its drawing context.
  // Only update them when dimensions really change.
  if (
    canvas.width !== viewWidth ||
    canvas.height !== viewHeight
  ) {
    canvas.width = viewWidth;
    canvas.height = viewHeight;
  }
}

window.addEventListener("resize", resizeCanvas);

document.addEventListener(
  "fullscreenchange",
  () => requestAnimationFrame(resizeCanvas)
);

if (window.ResizeObserver) {
  new ResizeObserver(() => {
    resizeCanvas();
  }).observe($("arenaWrap"));
}


// =======================================================
// TARGET GEOMETRY
// =======================================================

function activeTargetIndex() {
  return state.phase === "practice"
    ? 1
    : state.round;
}

function activeRadius() {
  return LEVELS[state.level].radius;
}

function cloneLayout(layout) {
  return layout.map(item => ({ ...item }));
}

function initializeTargetLayout() {
  const layout = LAYOUTS[activeTargetIndex()];

  state.currentLayout = cloneLayout(layout);
  state.fromLayout = cloneLayout(layout);
  state.targetLayout = cloneLayout(layout);
  state.transitioning = false;
}

function updateTargetAnimation(now) {
  if (!state.transitioning) return;

  const progress = clamp(
    (now - state.transitionStart) / TRANSITION_MS,
    0,
    1
  );

  const t = smoothstep(progress);

  state.currentLayout = state.fromLayout.map(
    (from, index) => {
      const to = state.targetLayout[index];

      return {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        scale: lerp(from.scale, to.scale, t)
      };
    }
  );

  if (progress >= 1) {
    state.currentLayout =
      cloneLayout(state.targetLayout);

    state.transitioning = false;
  }
}

function transitionTargets(index) {
  updateTargetAnimation(performance.now());

  state.fromLayout =
    cloneLayout(state.currentLayout);

  state.targetLayout =
    cloneLayout(LAYOUTS[index]);

  state.transitionStart = performance.now();
  state.transitioning = true;
}

function getTargetGeometry(index) {
  const layout =
    state.currentLayout[index] ||
    LAYOUTS[activeTargetIndex()][index];

  const active = index === activeTargetIndex();

  const radius = active
    ? activeRadius() * layout.scale
    : SMALL_RADIUS * (layout.scale / 0.44);

  return {
    x: stageOffset + layout.x * stageScale,
    y: BASE_HEIGHT / 2 +
      (layout.y - BASE_HEIGHT / 2) * stageScale,
    radius: radius * stageScale,
    active
  };
}


// =======================================================
// SOUND ENGINE
// Original synthesized sounds
// =======================================================

const audio = {
  context: null,
  enabled: false,
  musicInterval: null,
  beat: 0
};

function tone(
  frequency,
  duration = 0.16,
  volume = 0.035,
  type = "sine"
) {
  if (!audio.enabled || !audio.context) return;

  try {
    const ac = audio.context;
    const oscillator = ac.createOscillator();
    const gain = ac.createGain();

    oscillator.type = type;

    oscillator.frequency.setValueAtTime(
      frequency,
      ac.currentTime
    );

    gain.gain.setValueAtTime(
      Math.max(0.001, volume),
      ac.currentTime
    );

    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ac.currentTime + duration
    );

    oscillator.connect(gain);
    gain.connect(ac.destination);

    oscillator.start();
    oscillator.stop(
      ac.currentTime + duration + .02
    );
  } catch (error) {
    console.warn("Sound error:", error);
  }
}

function startMusic() {
  if (audio.enabled) return;

  try {
    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) return;

    if (!audio.context) {
      audio.context = new AudioContextClass();
    }

    audio.context.resume();
    audio.enabled = true;
    $("btnSound").textContent = "♫ SOUND ON";

    const melody = [
      196, 246.94, 293.66, 392,
      440, 392, 293.66, 246.94,
      220, 293.66, 349.23, 440,
      392, 293.66, 246.94, 196
    ];

    if (audio.musicInterval !== null) {
      clearInterval(audio.musicInterval);
    }

    audio.musicInterval = setInterval(() => {
      if (
        state.screen !== "Game" &&
        state.screen !== "Results"
      ) return;

      const note =
        melody[audio.beat % melody.length];

      audio.beat++;

      tone(note, .30, .013, "triangle");

      if (audio.beat % 4 === 0) {
        tone(note / 2, .40, .012);
      }
    }, 430);
  } catch (error) {
    console.warn("Music unavailable:", error);
  }
}

function toggleMusic() {
  if (audio.enabled) {
    audio.enabled = false;

    clearInterval(audio.musicInterval);
    audio.musicInterval = null;

    $("btnSound").textContent = "♫ SOUND OFF";
  } else {
    startMusic();
  }
}

function countdownTone(number) {
  tone(
    number === 0 ? 940 : 420 + number * 100,
    number === 0 ? .35 : .17,
    .07,
    "square"
  );
}

function shotSound(points, timedOut = false) {
  if (timedOut) {
    tone(160, .40, .08, "sawtooth");
  } else if (points === 10) {
    tone(784, .30, .09, "triangle");

    schedule(() => {
      tone(1046.5, .34, .07, "triangle");
    }, 140);
  } else if (points > 0) {
    tone(
      460 + points * 42,
      .17,
      .055,
      "triangle"
    );
  } else {
    tone(180, .23, .055, "sawtooth");
  }
}


// =======================================================
// REGISTRATION
// =======================================================

function startRegistration() {
  cancelTimers();

  state.player = "";
  state.previousScreen = "Welcome";

  $("playerName").value = "";
  $("nameError").textContent = "";

  showScreen("Name");
  $("playerName").focus();
}

function confirmName() {
  const name = $("playerName").value.trim();

  if (!name || name.length > 24) {
    $("nameError").textContent =
      "Enter a name between 1 and 24 characters.";
    return;
  }

  state.player = name;

  $("levelGreeting").textContent =
    `Welcome, ${name}. Choose your difficulty.`;

  showScreen("Level");
}

function chooseLevel(level) {
  if (!LEVELS[level]) return;

  state.level = level;

  document.querySelectorAll(".level-card")
    .forEach(button => {
      button.classList.toggle(
        "selected",
        button.dataset.level === level
      );
    });
}


// =======================================================
// GAME START
// =======================================================

function startGame() {
  cancelTimers();
  startMusic();

  state.phase = "practice";
  state.round = 0;
  state.practiceShots = 0;
  state.rounds = [[], [], []];
  state.hits = [];
  state.submitted = false;
  state.locked = false;

  initializeTargetLayout();

  showScreen("Game");
  hideOverlay();

  updateHUD();
  startShotTimer();
}


// =======================================================
// TEN-SECOND TIMER
// =======================================================

function startShotTimer() {
  if (
    state.screen !== "Game" ||
    state.locked
  ) return;

  state.deadline =
    performance.now() + SHOT_SECONDS * 1000;

  $("hudTimer").classList.remove(
    "hidden",
    "urgent"
  );

  $("hudTimer").textContent =
    String(SHOT_SECONDS);
}

function stopShotTimer() {
  state.deadline = 0;

  $("hudTimer").classList.add("hidden");
  $("hudTimer").classList.remove("urgent");
}

function timerExpired() {
  if (
    state.screen !== "Game" ||
    state.locked ||
    !state.deadline
  ) return;

  state.locked = true;
  stopShotTimer();

  registerShot(-1, -1, true);
}


// =======================================================
// OVERLAYS
// =======================================================

function hideOverlay() {
  $("gameOverlay").classList.add("hidden");
}

function showOverlay(
  eyebrow,
  title,
  message,
  button,
  callback,
  hideButton = false
) {
  state.locked = true;
  stopShotTimer();

  $("overlayEyebrow").textContent = eyebrow;
  $("overlayTitle").textContent = title;
  $("overlayText").textContent = message;

  const element = $("btnOverlayContinue");

  element.textContent = button;
  element.onclick = callback;
  element.classList.toggle("hidden", hideButton);

  $("gameOverlay").classList.remove("hidden");
}


// =======================================================
// 3–2–1 COUNTDOWN
// =======================================================

function beginCountdown(title, callback) {
  state.locked = true;
  stopShotTimer();
  hideOverlay();

  const token = ++state.countdownId;

  const overlay = $("countdown");
  const number = $("countdownNumber");

  $("countdownTitle").textContent = title;
  overlay.classList.remove("hidden");

  const sequence = ["3", "2", "1", "SHOOT!"];
  let index = 0;

  function tick() {
    if (
      token !== state.countdownId ||
      state.screen !== "Game"
    ) return;

    number.textContent = sequence[index];

    number.style.animation = "none";
    void number.offsetWidth;
    number.style.animation =
      "count-in .3s ease-out";

    countdownTone(
      index < 3 ? 3 - index : 0
    );

    index++;

    if (index < sequence.length) {
      schedule(tick, 1000);
    } else {
      schedule(() => {
        if (
          token !== state.countdownId ||
          state.screen !== "Game"
        ) return;

        overlay.classList.add("hidden");

        state.locked = false;
        callback();
        startShotTimer();
        updateHUD();
      }, 300);
    }
  }

  tick();
}


// =======================================================
// TARGET ROUND CHANGES
// =======================================================

function beginTournament() {
  state.phase = "round";
  state.round = 0;
  state.rounds = [[], [], []];
  state.hits = [];

  transitionTargets(0);
  updateHUD();

  beginCountdown(
    "TARGET 1 · GET READY",
    () => {
      $("gameMessage").textContent =
        "Target 1 · First arrow";
    }
  );
}

function advanceTarget() {
  if (state.round >= 2) {
    finishGame();
    return;
  }

  state.round++;
  state.hits = [];

  transitionTargets(state.round);
  updateHUD();

  beginCountdown(
    `TARGET ${state.round + 1} · GET READY`,
    () => {
      $("gameMessage").textContent =
        `Target ${state.round + 1} · First arrow`;
    }
  );
}


// =======================================================
// HIT DETECTION
// =======================================================

function calculateHitScore(x, y) {
  const target =
    getTargetGeometry(activeTargetIndex());

  const distance = Math.hypot(
    x - target.x,
    y - target.y
  );

  if (distance > target.radius) return 0;

  return clamp(
    10 - Math.floor(
      distance / (target.radius / 10)
    ),
    1,
    10
  );
}

function registerShot(x, y, timedOut = false) {
  if (state.screen !== "Game") return;

  if (
    !timedOut &&
    (
      state.locked ||
      !$("gameOverlay").classList.contains("hidden") ||
      !$("countdown").classList.contains("hidden")
    )
  ) return;

  if (
    !timedOut &&
    state.deadline &&
    performance.now() >= state.deadline
  ) {
    timerExpired();
    return;
  }

  state.locked = true;
  stopShotTimer();

  const points = timedOut
    ? 0
    : calculateHitScore(x, y);

  const target =
    getTargetGeometry(activeTargetIndex());

  const displayX = timedOut ? target.x : x;
  const displayY = timedOut ? target.y : y;

  state.hits.push({
    x: displayX,
    y: displayY,
    points,
    timedOut,
    at: performance.now()
  });

  showShotFeedback(
    points,
    displayX,
    displayY,
    timedOut
  );

  shotSound(points, timedOut);

  // PRACTICE
  if (state.phase === "practice") {
    state.practiceShots++;

    updateHUD();

    if (state.practiceShots >= 3) {
      schedule(() => {
        if (state.screen !== "Game") return;

        showOverlay(
          "PRACTICE COMPLETE",
          "TIME TO MAKE HISTORY",
          "Practice is complete. Three targets and twelve scoring arrows await.",
          "START CHALLENGE ➜",
          beginTournament
        );
      }, FEEDBACK_MS);
    } else {
      nextShotAfterFeedback();
    }

    return;
  }

  // TOURNAMENT
  const round = state.rounds[state.round];

  round.push(points);
  updateHUD();

  if (round.length < 4) {
    nextShotAfterFeedback();
    return;
  }

  const roundScore = scoreRound(round);

  schedule(() => {
    if (state.screen !== "Game") return;

    if (state.round < 2) {
      showOverlay(
        "TARGET COMPLETE",
        `TARGET ${state.round + 1} CLEARED`,
        `${roundScore}/30 points. Lowest shot discarded. Next target is coming up.`,
        "CONTINUE",
        advanceTarget,
        true
      );

      schedule(() => {
        if (state.screen === "Game") {
          advanceTarget();
        }
      }, 1700);
    } else {
      finishGame();
    }
  }, FEEDBACK_MS);
}

function nextShotAfterFeedback() {
  schedule(() => {
    if (
      state.screen !== "Game" ||
      !$("gameOverlay").classList.contains("hidden") ||
      !$("countdown").classList.contains("hidden")
    ) return;

    state.locked = false;
    state.hits = [];

    startShotTimer();
    updateHUD();
  }, FEEDBACK_MS);
}


// =======================================================
// SHOT FEEDBACK
// =======================================================

function showShotFeedback(points, x, y, timedOut) {
  const popup = $("shotPopup");

  popup.textContent =
    timedOut ? "TIME END" :
    points === 10 ? "BULLSEYE +10" :
    points === 0 ? "MISS · 0" :
    `+${points} POINTS`;

  popup.classList.toggle("timeout", timedOut);

  popup.style.left =
    clamp(x / viewWidth, .10, .90) * 100 + "%";

  popup.style.top =
    clamp(y / viewHeight, .12, .84) * 100 + "%";

  popup.classList.add("hidden");
  void popup.offsetWidth;
  popup.classList.remove("hidden");

  schedule(() => {
    popup.classList.add("hidden");
  }, 950);

  if (points === 10) {
    visualPulse = 1;
  }
}


// =======================================================
// SCOREBOARD
// =======================================================

function updateHUD() {
  $("hudPlayer").textContent =
    state.player.toUpperCase();

  $("hudMode").textContent =
    state.phase === "practice"
      ? "PRACTICE MODE"
      : `${state.level.toUpperCase()} CHALLENGE`;

  if (state.phase === "practice") {
    $("hudRound").textContent =
      `PRACTICE · ${state.practiceShots}/3`;

    $("hudInstruction").textContent =
      "Practice shots · 10 seconds each";
  } else {
    $("hudRound").textContent =
      `TARGET ${state.round + 1}/3 · SHOT ${
        Math.min(
          4,
          state.rounds[state.round].length + 1
        )
      }/4`;

    $("hudInstruction").textContent =
      "10 seconds per arrow · Best 3 count";
  }

  $("hudScore").innerHTML =
    `${totalScore()} <i>/ 90</i>`;

  const shots = state.phase === "practice"
    ? []
    : state.rounds[state.round];

  const slots = $("shotSlots");
  slots.replaceChildren();

  const dropped = shots.length === 4
    ? shots.indexOf(Math.min(...shots))
    : -1;

  for (let i = 0; i < 4; i++) {
    const element = document.createElement("span");

    element.textContent =
      shots[i] === undefined
        ? "—"
        : String(shots[i]);

    element.className =
      i === dropped ? "dropped" :
      shots[i] !== undefined ? "kept" : "";

    slots.appendChild(element);
  }

  const pills = $("roundPills");
  pills.replaceChildren();

  for (let i = 0; i < 3; i++) {
    const element = document.createElement("span");

    element.textContent =
      String(i + 1).padStart(2, "0");

    if (state.phase === "round") {
      element.className =
        i === state.round ? "active" :
        i < state.round ? "done" : "";
    }

    pills.appendChild(element);
  }

  $("gameMessage").textContent =
    state.phase === "practice"
      ? "Practice · Aim for the center"
      : `${4 - state.rounds[state.round].length} arrows remaining`;
}


// =======================================================
// POINTER INPUT
// =======================================================

function onCanvasPointer(event) {
  const rect = canvas.getBoundingClientRect();

  if (!rect.width || !rect.height) return;

  const x =
    (event.clientX - rect.left) /
    rect.width * viewWidth;

  const y =
    (event.clientY - rect.top) /
    rect.height * viewHeight;

  registerShot(x, y);
}


// =======================================================
// RESULTS / HALL OF FAME AUTO FLOW
// =======================================================

function finishGame() {
  if (state.submitted) return;

  state.submitted = true;
  state.locked = true;
  stopShotTimer();

  const token = ++state.cycleId;

  showScreen("Results");

  const total = totalScore();
  const allShots = state.rounds.flat();

  $("resultHeading").textContent =
    total >= 75 ? "GOLD-MEDAL PERFORMANCE!" :
    total >= 50 ? "INCREDIBLE FINISH!" :
    "CHALLENGE COMPLETE!";

  $("resultPlayer").textContent =
    `${state.player.toUpperCase()} · ${
      state.level.toUpperCase()
    }`;

  $("resultScore").textContent = total;

  $("resultAccuracy").textContent =
    (
      allShots.filter(s => s > 0).length /
      12 * 100
    ).toFixed(1) + "%";

  $("resultTens").textContent =
    allShots.filter(s => s === 10).length;

  $("resultRank").textContent = "…";

  const container = $("resultRounds");
  container.replaceChildren();

  state.rounds.forEach((round, index) => {
    const element = document.createElement("span");

    element.textContent =
      `TARGET ${index + 1}: ${scoreRound(round)}/30`;

    container.appendChild(element);
  });

  $("resultSaveStatus").textContent =
    "Saving your result…";

  createConfetti();
  saveFinalScore(token);

  schedule(() => {
    if (
      token !== state.cycleId ||
      state.screen !== "Results"
    ) return;

    showScreen("Hall");
    state.previousScreen = "Welcome";
    loadLeaderboard(state.level);

    schedule(() => {
      if (
        token === state.cycleId &&
        state.screen === "Hall"
      ) {
        showScreen("Welcome");
      }
    }, HALL_MS);
  }, RESULTS_MS);
}

async function saveFinalScore(token) {
  const player = state.player;
  const level = state.level;
  const rounds = state.rounds.map(r => [...r]);

  try {
    const response = await fetch("/api/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        player,
        level,
        rounds
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || "Save failed");
    }

    if (token === state.cycleId) {
      $("resultRank").textContent = "#" + data.rank;

      $("resultSaveStatus").textContent =
        "✓ Score saved to Hall of Fame";
    }
  } catch (error) {
    if (token === state.cycleId) {
      $("resultRank").textContent = "—";

      $("resultSaveStatus").textContent =
        "⚠ Score save failed: " + error.message;
    }
  }
}

function createConfetti() {
  const container = $("confetti");
  container.replaceChildren();

  const colors = [
    "#f4d06e",
    "#e4f2ff",
    "#75c2f2",
    "#e36b78"
  ];

  for (let i = 0; i < 42; i++) {
    const element = document.createElement("i");

    element.style.left = random(0, 100) + "%";
    element.style.width = random(4, 10) + "px";
    element.style.height = random(7, 17) + "px";
    element.style.background = colors[i % colors.length];
    element.style.animationDelay = random(0, 4) + "s";
    element.style.animationDuration = random(3, 5) + "s";

    container.appendChild(element);
  }
}


// =======================================================
// STADIUM DRAWING UTILITIES
// =======================================================

function polygon(points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);

  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(points[i], points[i + 1]);
  }

  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}


// =======================================================
// FULL-WIDTH OLYMPIC STADIUM
//
// All the audience, sky, stands and ground are drawn
// across viewWidth — including the former black sides.
//
// No targets are drawn in the extra side extensions.
// =======================================================

function drawStadium(time) {
  const w = viewWidth;
  const h = viewHeight;
  const center = w / 2;

  // SKY — entire screen
  const sky = ctx.createLinearGradient(
    0, 0, 0, h * .74
  );

  sky.addColorStop(0, "#0b2949");
  sky.addColorStop(.65, "#43768f");
  sky.addColorStop(1, "#8fa9a5");

  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // STADIUM LIGHT GLOW
  const glow = ctx.createRadialGradient(
    center, 180, 10,
    center, 180, w * .55
  );

  glow.addColorStop(0, "#f7e1ab24");
  glow.addColorStop(1, "#ffffff00");

  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, 600);

  // GRANDSTAND SHAPE
  polygon([
    0, 190,
    center - 490, 110,
    center - 170, 80,
    center + 170, 80,
    center + 490, 110,
    w, 190,
    w, 390,
    0, 390
  ], "#172d49");

  polygon([
    0, 235,
    center - 470, 160,
    center - 170, 143,
    center + 170, 143,
    center + 470, 160,
    w, 235,
    w, 395,
    0, 395
  ], "#253f5a");

  // AUDIENCE SEATING ACROSS FULL WIDTH
  for (let row = 0; row < 13; row++) {
    const y = 170 + row * 16;

    ctx.strokeStyle =
      row % 2 === 0
        ? "#c1d4e31b"
        : "#52728d28";

    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(
      center, y - 70, w, y
    );
    ctx.stroke();

    const count = Math.ceil(w / 16);

    for (let column = 0; column < count; column++) {
      const x = column * 16 + (row % 2) * 8;

      const distance =
        Math.abs(x - center) / Math.max(center, 1);

      const crowdY =
        y - 47 * (1 - distance * distance);

      const variation =
        (column * 31 + row * 47) % 9;

      ctx.fillStyle =
        variation < 3 ? "#cedbe69b" :
        variation < 6 ? "#7ca5bf88" :
        "#344c6ea5";

      ctx.fillRect(
        x,
        crowdY + Math.sin(time * .002 + x) * .7,
        3,
        4
      );
    }
  }

  // STADIUM BARRIERS ACROSS FULL WIDTH
  ctx.fillStyle = "#0d243b";
  ctx.fillRect(0, 364, w, 33);

  ctx.fillStyle = "#17415b";
  ctx.fillRect(0, 385, w, 13);

  // GREEN GROUND
  const grass = ctx.createLinearGradient(
    0, 400, 0, h
  );

  grass.addColorStop(0, "#2a7753");
  grass.addColorStop(1, "#103d34");

  ctx.fillStyle = grass;
  ctx.fillRect(0, 398, w, h - 398);

  // MOWED GRASS STRIPES
  for (let x = 0; x < w; x += 80) {
    ctx.fillStyle =
      Math.floor(x / 80) % 2 === 0
        ? "#b6dfaa09"
        : "#0618120b";

    ctx.fillRect(
      x, 398, 80, h - 398
    );
  }

  // FIELD DEPTH LINES
  for (let y = 430; y < h; y += 55) {
    ctx.strokeStyle = "#e8f7dd1c";
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // ORIGINAL CENTRAL SHOOTING LANE
  // Ground continues outside this lane.
  polygon([
    center - 200, 398,
    center + 200, 398,
    center + 600, h,
    center - 600, h
  ], "#427d774e");

  ctx.strokeStyle = "#e6f3d38a";
  ctx.lineWidth = 3;

  ctx.beginPath();

  ctx.moveTo(center - 200, 398);
  ctx.lineTo(center - 600, h);

  ctx.moveTo(center + 200, 398);
  ctx.lineTo(center + 600, h);

  ctx.stroke();

  // OUTER LANE DETAILS IN THE SIDE EXTENSIONS
  // These are ground markings, not targets.
  ctx.strokeStyle = "#e5f1de26";
  ctx.lineWidth = 2;

  for (const direction of [-1, 1]) {
    ctx.beginPath();

    ctx.moveTo(
      center + direction * 420,
      398
    );

    ctx.lineTo(
      center + direction * (420 + 380),
      h
    );

    ctx.stroke();
  }

  // FLOODLIGHT TOWERS NEAR OUTER SIDES
  for (const x of [45, w - 45]) {
    ctx.fillStyle = "#14283e";
    ctx.fillRect(x - 6, 15, 12, 250);

    ctx.fillStyle = "#eae4c7";
    ctx.fillRect(x - 32, 16, 64, 17);

    for (let i = 0; i < 5; i++) {
      ctx.fillStyle =
        `rgba(255,245,210,${
          .65 + .18 * Math.sin(time * .002 + i)
        })`;

      ctx.fillRect(
        x - 27 + i * 12,
        20, 9, 8
      );
    }
  }

  // STADIUM TITLE
  ctx.fillStyle = "#e7f3ff";
  ctx.font = "bold 15px Segoe UI";
  ctx.textAlign = "center";

  ctx.fillText(
    "OLYMPIC ARCHERY ARENA · PRECISION CHALLENGE",
    center,
    385
  );
}


// =======================================================
// PERFECT CIRCULAR RECURVE TARGET
// =======================================================

function drawTarget(
  x,
  y,
  radius,
  isActive,
  time,
  index
) {
  ctx.save();

  // OUTER SHADOW
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = isActive ? 22 : 10;
  ctx.shadowOffsetY = 5;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);

  ctx.fillStyle = "#FFFFFF";
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // FIVE DOUBLE-RING COLOUR BANDS
  const bands = [
    { size: 1.0, color: "#FFFFFF" },
    { size: 0.8, color: "#171717" },
    { size: 0.6, color: "#00A2DE" },
    { size: 0.4, color: "#E30620" },
    { size: 0.2, color: "#FFE000" }
  ];

  for (const band of bands) {
    ctx.beginPath();

    ctx.arc(
      x, y,
      radius * band.size,
      0, Math.PI * 2
    );

    ctx.fillStyle = band.color;
    ctx.fill();
  }

  // TEN SCORING CIRCLES
  for (let ring = 1; ring <= 10; ring++) {
    ctx.beginPath();

    ctx.arc(
      x, y,
      radius * ring / 10,
      0, Math.PI * 2
    );

    ctx.strokeStyle =
      "rgba(30,30,30,0.45)";

    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // HORIZONTAL NUMBER MARKINGS
  if (isActive) {
    ctx.font =
      `500 ${Math.max(10, radius * .084)}px Arial`;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let score = 10; score >= 1; score--) {
      const distance =
        radius * (10.5 - score) / 10;

      ctx.fillStyle =
        score >= 9 || score <= 2
          ? "#262626"
          : "#FFFFFF";

      ctx.fillText(
        String(score),
        x + distance,
        y
      );
    }
  }

  // OUTER CIRCLE BORDER
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);

  ctx.strokeStyle = "#262626";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // ACTIVE GOLD HIGHLIGHT
  if (isActive) {
    const pulse =
      .5 + .5 * Math.sin(time * .003);

    ctx.beginPath();

    ctx.arc(
      x, y,
      radius + 9,
      0, Math.PI * 2
    );

    ctx.strokeStyle = "#FFD36B";
    ctx.lineWidth = 4;

    ctx.shadowColor = "#FFD36B";
    ctx.shadowBlur = 9 + pulse * 13;

    ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);

    ctx.fillStyle = "rgba(9,20,33,.10)";
    ctx.fill();
  }

  // NAME LABEL
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${isActive ? 18 : 14}px Arial`;

  ctx.fillStyle =
    isActive ? "#FFE39B" : "#D9E7F4";

  ctx.fillText(
    `TARGET ${index + 1}`,
    x,
    y + radius + (isActive ? 29 : 23)
  );

  ctx.restore();
}


// =======================================================
// CALIBRATION GRID — FULL PROJECTED WALL
// =======================================================

function drawCalibration() {
  ctx.save();

  ctx.strokeStyle = "#c9f7ff65";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 10; i++) {
    const x = i * viewWidth / 10;

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewHeight);
    ctx.stroke();
  }

  for (let i = 0; i <= 10; i++) {
    const y = i * viewHeight / 10;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(viewWidth, y);
    ctx.stroke();
  }

  // 4-inch dead zones on the 149-inch wall.
  const left = viewWidth * 4 / 149;
  const right = viewWidth * 145 / 149;

  ctx.strokeStyle = "#ff8b8b";
  ctx.lineWidth = 3;

  for (const x of [left, right]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewHeight);
    ctx.stroke();
  }

  ctx.restore();
}


// =======================================================
// MAIN RENDER LOOP
// =======================================================

function render(time) {
  updateTargetAnimation(time);

  ctx.clearRect(
    0, 0,
    viewWidth, viewHeight
  );

  // Entire viewport gets stadium.
  drawStadium(time);

  const active = activeTargetIndex();

  // Draw two background targets first.
  for (let index = 0; index < 3; index++) {
    if (index === active) continue;

    const target = getTargetGeometry(index);

    drawTarget(
      target.x,
      target.y,
      target.radius,
      false,
      time,
      index
    );
  }

  // Draw active foreground target last.
  const foreground = getTargetGeometry(active);

  drawTarget(
    foreground.x,
    foreground.y,
    foreground.radius,
    true,
    time,
    active
  );

  if (state.screen === "Game") {
    if (state.calibration) {
      drawCalibration();
    }

    // LiDAR marker
    if (
      state.lidar &&
      state.lidarMarker &&
      time - state.lidarMarker.at < 800
    ) {
      ctx.save();

      ctx.strokeStyle = "#00FFBA";
      ctx.lineWidth = 5;

      ctx.beginPath();

      ctx.arc(
        state.lidarMarker.x,
        state.lidarMarker.y,
        16,
        0,
        Math.PI * 2
      );

      ctx.stroke();
      ctx.restore();
    }

    // Shot impacts
    for (const hit of state.hits) {
      const elapsed = time - hit.at;

      if (
        elapsed < 0 ||
        elapsed > 3500 ||
        hit.timedOut
      ) continue;

      ctx.save();

      ctx.globalAlpha =
        1 - elapsed / 3500;

      ctx.fillStyle =
        hit.points > 0
          ? "#132235"
          : "#AB3647";

      ctx.strokeStyle =
        hit.points > 0
          ? "#FFE9A5"
          : "#FF7689";

      ctx.lineWidth = 3;

      ctx.beginPath();
      ctx.arc(
        hit.x, hit.y,
        6, 0, Math.PI * 2
      );

      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    // Bullseye flash
    if (visualPulse > 0) {
      ctx.fillStyle =
        `rgba(255,221,127,${visualPulse * .18})`;

      ctx.fillRect(
        0, 0,
        viewWidth, viewHeight
      );

      visualPulse *= .91;

      if (visualPulse < .02) {
        visualPulse = 0;
      }
    }

    // Shot timer
    if (!state.locked && state.deadline > 0) {
      const remaining =
        (state.deadline - performance.now()) / 1000;

      if (remaining <= 0) {
        timerExpired();
      } else {
        const seconds = Math.ceil(remaining);

        $("hudTimer").textContent =
          String(seconds);

        $("hudTimer").classList.toggle(
          "urgent",
          seconds <= 3
        );
      }
    }
  }

  requestAnimationFrame(render);
}


// =======================================================
// LEADERBOARD
// =======================================================

async function openHall() {
  cancelTimers();

  state.previousScreen =
    state.screen === "Game"
      ? "Welcome"
      : state.screen;

  showScreen("Hall");
  await loadLeaderboard("all");
}

async function loadLeaderboard(level) {
  state.selectedFilter = level;
  const requestId = ++leaderboardRequestId;

  document.querySelectorAll(".hall-filters button")
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.filter === level
      );
    });

  const body = $("leaderboardBody");
  body.replaceChildren();

  const loading = document.createElement("tr");
  const loadingCell = document.createElement("td");

  loadingCell.colSpan = 6;
  loadingCell.textContent = "Loading leaderboard…";

  loading.appendChild(loadingCell);
  body.appendChild(loading);

  try {
    const response = await fetch(
      "/api/leaderboard?level=" +
      encodeURIComponent(level)
    );

    if (!response.ok) {
      throw Error("Unable to load leaderboard");
    }

    const data = await response.json();

    if (
      requestId !== leaderboardRequestId ||
      state.selectedFilter !== level ||
      state.screen !== "Hall"
    ) return;

    body.replaceChildren();

    if (!data.entries.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 6;
      cell.textContent =
        "No scores yet. Be the first champion!";

      row.appendChild(cell);
      body.appendChild(row);
    }

    data.entries.forEach((entry, index) => {
      const row = document.createElement("tr");

      const values = [
        index + 1,
        entry.player,
        entry.level.toUpperCase(),
        `${entry.total}/90`,
        `${entry.accuracy}%`,
        entry.created_at.slice(0, 10)
      ];

      for (const value of values) {
        const cell = document.createElement("td");

        cell.textContent = String(value);
        row.appendChild(cell);
      }

      body.appendChild(row);
    });

    $("sessionCount").textContent =
      `${data.sessions} completed sessions`;

  } catch (error) {
    if (requestId !== leaderboardRequestId) return;

    body.replaceChildren();

    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 6;

    cell.textContent =
      "Could not load leaderboard: " + error.message;

    row.appendChild(cell);
    body.appendChild(row);
  }
}


// =======================================================
// RESET HALL OF FAME
// =======================================================

async function resetLeaderboard() {
  const pin = $("adminPin").value;

  if (!pin) {
    $("adminStatus").textContent =
      "Enter the operator PIN.";
    return;
  }

  if (!confirm(
    "Delete all Hall of Fame records? This cannot be undone."
  )) return;

  try {
    const response = await fetch(
      "/api/admin/reset",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ pin })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || "Reset failed");
    }

    $("adminPin").value = "";
    $("adminStatus").textContent =
      `Deleted ${data.deleted} records.`;

    toast("Hall of Fame reset completed");

    if (state.screen === "Hall") {
      loadLeaderboard(state.selectedFilter);
    }
  } catch (error) {
    $("adminStatus").textContent = error.message;
  }
}


// =======================================================
// LD19 LIDAR INPUT
//
// x_norm/y_norm represent the full physical wall.
// Therefore they are mapped across the ENTIRE wide
// stadium canvas, not only its central target stage.
// =======================================================

async function pollLidar() {
  if (!state.lidar || lidarRequestActive) return;

  const generation = lidarGeneration;
  lidarRequestActive = true;

  try {
    const response = await fetch(
      `/api/input-events?after=${state.lidarSeq}`,
      { cache: "no-store" }
    );

    if (!response.ok) return;

    const data = await response.json();

    if (
      generation !== lidarGeneration ||
      !state.lidar
    ) return;

    state.lidarSeq = Math.max(
      state.lidarSeq,
      data.seq
    );

    for (const event of data.events) {
      // Full-width coordinate mapping.
      const x = event.x * viewWidth;
      const y = event.y * viewHeight;

      state.lidarMarker = {
        x,
        y,
        at: performance.now()
      };

      if (
        event.type !== "touch_down" &&
        event.type !== "down"
      ) continue;

      if (
        state.screen !== "Game" ||
        state.locked
      ) continue;

      if (
        Date.now() - state.lastLidarAt < 350
      ) continue;

      state.lastLidarAt = Date.now();

      registerShot(x, y);
    }
  } catch (error) {
    // LiDAR remains optional.
  } finally {
    lidarRequestActive = false;
  }
}


// =======================================================
// BUTTON EVENTS
// =======================================================

$("btnChallenge").onclick = startRegistration;
$("btnWelcomeHall").onclick = openHall;
$("btnHall").onclick = openHall;

$("btnNameNext").onclick = confirmName;
$("btnNameBack").onclick = () => showScreen("Welcome");

$("playerName").addEventListener(
  "keydown",
  event => {
    if (event.key === "Enter") {
      confirmName();
    }
  }
);

document.querySelectorAll(".level-card")
  .forEach(button => {
    button.onclick = () => {
      chooseLevel(button.dataset.level);
    };
  });

$("btnLevelBack").onclick =
  () => showScreen("Name");

$("btnLevelNext").onclick = startGame;

$("btnPlayAgain").onclick = startRegistration;
$("btnResultHall").onclick = openHall;
$("btnHallPlay").onclick = startRegistration;

$("btnHallBack").onclick = () => {
  cancelTimers();

  const previous = state.previousScreen;

  showScreen(
    ["Hall", "Game", "Results"].includes(previous)
      ? "Welcome"
      : previous
  );
};

document.querySelectorAll(".hall-filters button")
  .forEach(button => {
    button.onclick = () => {
      loadLeaderboard(button.dataset.filter);
    };
  });

$("btnFullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }

    requestAnimationFrame(resizeCanvas);
  } catch (error) {
    toast("Fullscreen unavailable", true);
  }
};

$("btnSound").onclick = toggleMusic;

$("btnOperator").onclick = () => {
  $("adminStatus").textContent = "";
  $("operatorModal").classList.remove("hidden");
};

$("btnCloseModal").onclick = () => {
  $("operatorModal").classList.add("hidden");
};

$("operatorModal").addEventListener(
  "click",
  event => {
    if (event.target === $("operatorModal")) {
      $("operatorModal").classList.add("hidden");
    }
  }
);

$("btnReset").onclick = resetLeaderboard;

$("calibrateToggle").onchange = event => {
  state.calibration = event.target.checked;

  toast(
    state.calibration
      ? "Calibration grid enabled"
      : "Calibration grid disabled"
  );
};

$("lidarToggle").onchange = async event => {
  state.lidar = event.target.checked;

  const generation = ++lidarGeneration;

  if (state.lidar) {
    try {
      const response = await fetch(
        "/api/input-events?after=0",
        { cache: "no-store" }
      );

      if (response.ok) {
        const data = await response.json();

        if (
          generation === lidarGeneration &&
          state.lidar
        ) {
          state.lidarSeq = data.seq;
        }
      }
    } catch (error) {
      // Optional input.
    }
  }

  toast(
    state.lidar
      ? "LiDAR enabled"
      : "LiDAR disabled"
  );
};

$("btnQuit").onclick = () => {
  if (confirm(
    "Exit challenge? Unsaved progress will be lost."
  )) {
    cancelTimers();
    showScreen("Welcome");
  }
};

canvas.addEventListener(
  "pointerdown",
  onCanvasPointer
);

window.addEventListener("keydown", event => {
  if (
    event.key === "Escape" &&
    !$("operatorModal").classList.contains("hidden")
  ) {
    $("operatorModal").classList.add("hidden");
  }
});


// =======================================================
// INITIALIZATION
// =======================================================

chooseLevel("medium");
initializeTargetLayout();
showScreen("Welcome");

setInterval(pollLidar, 65);
requestAnimationFrame(render);

console.log(
  "Olympic Archery Arena — Full Width Stadium Ready"
);