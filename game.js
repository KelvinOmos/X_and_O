import { EMPTY_BOARD, getWinner, getWinningLine, isDraw, makeTurn } from "./game-core.js";

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const cells          = [...document.querySelectorAll(".cell")];
const winningLine    = document.querySelector("#winning-line");
const turnLabel      = document.querySelector("#turn-label");
const turnMark       = document.querySelector("#turn-mark");
const resultMessage  = document.querySelector("#result-message");
const statusMessage  = document.querySelector("#status-message");
const scoreX         = document.querySelector("#score-x");
const scoreO         = document.querySelector("#score-o");
const scoreDraw      = document.querySelector("#score-draw");
const createButton   = document.querySelector("#create-match");
const joinButton     = document.querySelector("#join-match");
const reconnectButton = document.querySelector("#reconnect-match");
const joinCode       = document.querySelector("#join-code");
const matchCode      = document.querySelector("#match-code");
const matchCodeValue = document.querySelector("#match-code-value");
const practiceButton = document.querySelector("#practice-mode");
const newRoundButton = document.querySelector("#new-round");
const restartButton  = document.querySelector("#restart");
const playerName     = document.querySelector("#player-name");
const rematchDialog  = document.querySelector("#rematch-dialog");
const rematchMessage = document.querySelector("#rematch-message");
const rematchAccept  = document.querySelector("#rematch-accept");
const rematchDecline = document.querySelector("#rematch-decline");
const ROOM_CODE_KEY  = "three-in-a-row-room-code";
const ROOM_TOKEN_KEY = "three-in-a-row-room-token";

// ─── Game state ───────────────────────────────────────────────────────────────

let mode          = "practice"; // "practice" | "online"
let board         = [...EMPTY_BOARD];
let currentPlayer = "X";
let practiceStartingPlayer = "X";
let roundOver     = false;
let activeCode    = null;       // current room code
let gameSocket    = null;
let yourMark      = "X";
let players       = [];         // [{ mark, name }]
let connectedCount = 0;
let scores        = { X: 0, O: 0, draw: 0 };
let roundCounted  = false;      // prevent double-counting online results
let rematchVotes  = { X: null, O: null };
let rematchStatus = null;
let reconnectToken = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

function getName() {
  return (playerName.value.trim() || "Player").slice(0, 20);
}

function saveReconnectSession(code, token) {
  const previousCode = sessionStorage.getItem(ROOM_CODE_KEY);
  if (previousCode && previousCode !== code) localStorage.removeItem(`${ROOM_TOKEN_KEY}:${previousCode}`);
  sessionStorage.setItem(ROOM_CODE_KEY, code);
  if (token) localStorage.setItem(`${ROOM_TOKEN_KEY}:${code}`, token);
  else localStorage.removeItem(`${ROOM_TOKEN_KEY}:${code}`);
}

function clearReconnectSession() {
  const code = sessionStorage.getItem(ROOM_CODE_KEY);
  if (code) localStorage.removeItem(`${ROOM_TOKEN_KEY}:${code}`);
  sessionStorage.removeItem(ROOM_CODE_KEY);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const winner   = getWinner(board);
  const draw     = isDraw(board);
  const isOnline = mode === "online";
  const myTurn   = !isOnline || currentPlayer === yourMark;
  const canPlay  = !roundOver && (!isOnline || connectedCount === 2) && myTurn;

  if (draw && (mode !== "online" || rematchStatus !== "declined")) {
    if (!rematchDialog.open) rematchDialog.showModal();
    const hasVoted = isOnline && rematchVotes[yourMark] !== null;
    rematchMessage.textContent = hasVoted
      ? "Waiting for your friend to decide."
      : "Would you like to play a rematch?";
    rematchAccept.disabled = hasVoted;
    rematchDecline.disabled = hasVoted;
  } else {
    if (rematchDialog.open) rematchDialog.close();
    rematchAccept.disabled = false;
    rematchDecline.disabled = false;
  }

  cells.forEach((cell, i) => {
    const val = board[i];
    cell.textContent = val ?? "";
    cell.classList.toggle("mark-x", val === "X");
    cell.classList.toggle("mark-o", val === "O");
    cell.disabled = Boolean(val) || !canPlay;
    cell.setAttribute("aria-label", val ? `Square ${i + 1}: ${val}` : `Square ${i + 1}: empty`);
  });

  const winningCells = getWinningLine(board);
  if (winningCells) {
    winningLine.removeAttribute("hidden");
    const boardRect = winningLine.parentElement.getBoundingClientRect();
    const getCenter = (index) => {
      const rect = cells[index].getBoundingClientRect();
      return {
        x: ((rect.left + rect.width / 2 - boardRect.left) / boardRect.width) * 300,
        y: ((rect.top + rect.height / 2 - boardRect.top) / boardRect.height) * 300,
      };
    };
    const start = getCenter(winningCells[0]);
    const end = getCenter(winningCells[2]);
    winningLine.firstElementChild.setAttribute("x1", start.x);
    winningLine.firstElementChild.setAttribute("y1", start.y);
    winningLine.firstElementChild.setAttribute("x2", end.x);
    winningLine.firstElementChild.setAttribute("y2", end.y);
  } else {
    winningLine.setAttribute("hidden", "");
  }

  turnMark.textContent = roundOver ? (winner || "—") : currentPlayer;
  turnMark.className   = `turn-mark ${winner ? `mark-${winner.toLowerCase()}` : ""}`;

  turnLabel.textContent =
    roundOver                           ? "ROUND COMPLETE"          :
    isOnline && connectedCount < 2      ? "WAITING FOR OPPONENT"    :
    isOnline && !myTurn                 ? "OPPONENT'S TURN"         :
    isOnline                            ? "YOUR TURN"               :
                                          `${currentPlayer}'S TURN`;

  if (winner) {
    const wp = players.find((p) => p.mark === winner);
    resultMessage.textContent = wp ? `${wp.name} wins!` : `${winner} wins!`;
    resultMessage.classList.add("visible");
  } else if (draw) {
    resultMessage.textContent = "A well-played draw";
    resultMessage.classList.add("visible");
  } else {
    resultMessage.textContent = "";
    resultMessage.classList.remove("visible");
  }

  scoreX.textContent    = scores.X;
  scoreO.textContent    = scores.O;
  scoreDraw.textContent = scores.draw;

  const isConnected    = gameSocket?.readyState === WebSocket.OPEN;
  const matchActive    = isOnline && activeCode && !roundOver;

  createButton.disabled    = Boolean(matchActive);
  joinButton.disabled      = Boolean(matchActive);
  joinCode.disabled        = Boolean(matchActive);
  playerName.disabled      = Boolean(matchActive);

  reconnectButton.hidden   = !activeCode || isConnected;

  // In online mode: "New round" starts a new round in the same room
  // In practice mode: "New round" resets the local board
  newRoundButton.disabled  = isOnline && (draw || !roundOver);

  restartButton.textContent = isOnline ? "Leave match" : "Reset practice score";

  matchCode.hidden = !(isOnline && activeCode);
  if (activeCode) matchCodeValue.textContent = activeCode;
}

// ─── Practice mode ────────────────────────────────────────────────────────────

function endLocalRound() {
  const winner = getWinner(board);
  if (winner)       { scores[winner] += 1; roundOver = true; }
  else if (isDraw(board)) { scores.draw  += 1; roundOver = true; }
}

function playPractice(index) {
  const result = makeTurn(board, index, currentPlayer, currentPlayer);
  if (result.error) return;
  board = result.board;
  endLocalRound();
  if (!roundOver) currentPlayer = currentPlayer === "X" ? "O" : "X";
  render();
}

function resetBoard(startingPlayer = "X") {
  if (rematchDialog.open) rematchDialog.close();
  board         = [...EMPTY_BOARD];
  currentPlayer = startingPlayer;
  roundOver     = false;
  roundCounted  = false;
  render();
}

function startNextPracticeRound() {
  practiceStartingPlayer = practiceStartingPlayer === "X" ? "O" : "X";
  resetBoard(practiceStartingPlayer);
}

// ─── Online mode — state ──────────────────────────────────────────────────────

function countOnlineResult(state) {
  if (roundCounted || state.status !== "finished") return;
  roundCounted = true;
  const winner = getWinner(state.board);
  if (winner) scores[winner] += 1;
  else        scores.draw    += 1;
}

function receiveState(state) {
  if (!Array.isArray(state.board) || state.board.length !== 9) {
    setStatus("Received an invalid board from the server.", true);
    return;
  }

  // Detect a new round starting (status flips from finished → playing)
  if (roundOver && state.status !== "finished") roundCounted = false;

  board          = state.board;
  currentPlayer  = state.currentPlayer;
  yourMark       = state.yourMark;
  players        = state.players ?? [];
  connectedCount = state.connected;
  roundOver      = state.status === "finished";
  rematchVotes   = state.rematchVotes ?? { X: null, O: null };
  rematchStatus  = state.rematchStatus ?? null;
  if (typeof state.reconnectToken === "string" && /^[a-f0-9]{64}$/.test(state.reconnectToken)) {
    reconnectToken = state.reconnectToken;
    saveReconnectSession(activeCode, reconnectToken);
  }

  countOnlineResult(state);

  if (state.status === "waiting") {
    setStatus("Share this code with your friend — the game starts when they join.");
  } else if (rematchStatus === "declined") {
    setStatus("Rematch declined. The draw stands.");
  } else if (rematchStatus === "waiting") {
    setStatus(rematchVotes[yourMark]
      ? "Your rematch vote is in. Waiting for your friend."
      : "Your friend accepted the rematch. Choose whether to join.");
  } else if (connectedCount < 2) {
    setStatus("Opponent disconnected. Waiting for them to reconnect…");
  } else {
    const opponent = players.find((p) => p.mark !== yourMark);
    setStatus(`You are ${yourMark}. Playing against ${opponent?.name ?? "your opponent"}.`);
  }

  render();
}

// ─── Online mode — connection ─────────────────────────────────────────────────

function connectToRoom(code, token = null) {
  if (gameSocket && gameSocket.readyState <= WebSocket.OPEN) gameSocket.close(1000);

  mode       = "online";
  activeCode = code;
  reconnectToken = token;
  saveReconnectSession(code, token);
  if (token) {
    setStatus("Reconnecting…");
    render();
  } else {
    resetBoard(practiceStartingPlayer);
    setStatus("Connecting…");
  }

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/realtime?code=${encodeURIComponent(code)}`);
  gameSocket   = socket;

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", name: getName(), token }));
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch {
      setStatus("Received an unreadable message from the server.", true);
      return;
    }
    if (msg.type === "state") receiveState(msg);
    else if (msg.type === "error") setStatus(msg.message, true);
  });

  socket.addEventListener("close", (event) => {
    if (gameSocket === socket) gameSocket = null;
    if (mode === "online" && event.code !== 1000) {
      setStatus("Connection lost. Click Reconnect to continue.", true);
    }
    render();
  });

  socket.addEventListener("error", () => {
    setStatus("Could not connect to the game server.", true);
  });
}

async function createMatch() {
  try {
    createButton.disabled = true;
    setStatus("Creating match…");
    const res    = await fetch("/room/create", { method: "POST" });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? "Could not create match.");
    connectToRoom(result.code);
  } catch (err) {
    setStatus(err.message, true);
    render();
  }
}

async function joinMatch() {
  const code = joinCode.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setStatus("Enter the 6-character code from your friend.", true);
    return;
  }
  try {
    joinButton.disabled = true;
    setStatus("Joining match…");
    const res    = await fetch("/room/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? "Could not join match.");
    connectToRoom(code);
  } catch (err) {
    setStatus(err.message, true);
    render();
  }
}

function leaveMatch() {
  if (gameSocket?.readyState === WebSocket.OPEN) gameSocket.close(1000, "Left match");
  clearReconnectSession();
  gameSocket     = null;
  activeCode     = null;
  reconnectToken = null;
  mode           = "practice";
  players        = [];
  connectedCount = 0;
  scores         = { X: 0, O: 0, draw: 0 };
  practiceStartingPlayer = "X";
  resetBoard(practiceStartingPlayer);
  setStatus("Practice mode — take turns on this device.");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

cells.forEach((cell, index) => {
  cell.addEventListener("click", () => {
    if (mode === "practice") {
      playPractice(index);
      return;
    }
    if (gameSocket?.readyState === WebSocket.OPEN) {
      gameSocket.send(JSON.stringify({ type: "move", index }));
    }
  });
});

createButton.addEventListener("click", createMatch);
joinButton.addEventListener("click", joinMatch);

practiceButton.addEventListener("click", leaveMatch);

newRoundButton.addEventListener("click", () => {
  if (mode === "online") {
    if (gameSocket?.readyState === WebSocket.OPEN) {
      gameSocket.send(JSON.stringify({ type: "new-round" }));
    }
    return;
  }
  if (roundOver) startNextPracticeRound();
  else resetBoard(practiceStartingPlayer);
  setStatus(`Practice mode — ${currentPlayer} starts the next round.`);
});

rematchAccept.addEventListener("click", () => {
  if (mode === "online") {
    if (gameSocket?.readyState === WebSocket.OPEN) {
      gameSocket.send(JSON.stringify({ type: "rematch-vote", accept: true }));
    }
    return;
  }
  startNextPracticeRound();
  setStatus(`Practice mode — ${currentPlayer} starts the rematch.`);
});

rematchDecline.addEventListener("click", () => {
  if (mode === "online") {
    if (gameSocket?.readyState === WebSocket.OPEN) {
      gameSocket.send(JSON.stringify({ type: "rematch-vote", accept: false }));
    }
    return;
  }
  rematchDialog.close();
});

rematchDialog.addEventListener("cancel", (event) => {
  if (mode === "online" && isDraw(board)) event.preventDefault();
});

restartButton.addEventListener("click", () => {
  if (mode === "online") {
    leaveMatch();
    return;
  }
  scores = { X: 0, O: 0, draw: 0 };
  resetBoard();
  setStatus("Practice score reset.");
});

reconnectButton.addEventListener("click", () => {
  if (activeCode) connectToRoom(activeCode, reconnectToken);
});

joinCode.addEventListener("keydown", (e) => { if (e.key === "Enter") joinMatch(); });
joinCode.addEventListener("input", () => {
  joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

const savedCode = sessionStorage.getItem(ROOM_CODE_KEY);
const savedToken = savedCode ? localStorage.getItem(`${ROOM_TOKEN_KEY}:${savedCode}`) : null;
if (savedCode && /^[A-Z0-9]{6}$/.test(savedCode) && savedToken && /^[a-f0-9]{64}$/.test(savedToken)) {
  connectToRoom(savedCode, savedToken);
} else {
  if (savedCode) clearReconnectSession();
  setStatus("Enter your name and create a match to play online, or play locally below.");
  render();
}
