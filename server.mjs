import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { EMPTY_BOARD, getWinner, isDraw, makeTurn } from "./game-core.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const ROOM_TTL_MS = 10 * 60 * 1000; // rooms expire after 10 minutes of inactivity

// ─── Static file map ──────────────────────────────────────────────────────────

const files = new Map([
  ["/",           ["index.html",  "text/html; charset=utf-8"]],
  ["/index.html", ["index.html",  "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css",  "text/css; charset=utf-8"]],
  ["/game.js",    ["game.js",     "text/javascript; charset=utf-8"]],
  ["/game-core.js", ["game-core.js", "text/javascript; charset=utf-8"]],
]);

// ─── Room management ──────────────────────────────────────────────────────────

const rooms   = new Map();   // code → room
const sockets = new WeakMap(); // ws → client

// Unambiguous characters (no O/0/I/1 confusion)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode() {
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function freshRoom(code) {
  return {
    code,
    players: [],           // [{ id, name, mark }]
    board: [...EMPTY_BOARD],
    currentPlayer: "X",
    startingPlayer: "X",
    clients: new Map(),    // playerId → WebSocket
    rematchVotes: new Map(),
    rematchStatus: null,
    status: "waiting",     // "waiting" | "playing" | "finished"
    timer: null,
  };
}

function touchRoom(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    for (const ws of room.clients.values()) ws.close(1001, "Room expired");
    rooms.delete(room.code);
  }, ROOM_TTL_MS);
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function stateFor(room, playerId) {
  const winner = getWinner(room.board);
  const draw   = isDraw(room.board);
  const self   = room.players.find((p) => p.id === playerId);
  return {
    type:          "state",
    board:         room.board,
    currentPlayer: room.currentPlayer,
    yourMark:      self?.mark ?? null,
    players:       room.players.map((p) => ({ mark: p.mark, name: p.name })),
    connected:     room.clients.size,
    status:        winner || draw ? "finished" : room.status,
    winner:        winner ?? (draw ? "draw" : null),
    reconnectToken: self?.token ?? null,
    rematchVotes:  Object.fromEntries(room.players.map((player) => [
      player.mark,
      room.rematchVotes.get(player.id) ?? null,
    ])),
    rematchStatus: room.rematchStatus,
  };
}

function broadcast(room) {
  for (const [pid, ws] of room.clients) send(ws, stateFor(room, pid));
}

function startNextRound(room) {
  room.startingPlayer = room.startingPlayer === "X" ? "O" : "X";
  room.board = [...EMPTY_BOARD];
  room.currentPlayer = room.startingPlayer;
  room.status = "playing";
  room.rematchVotes.clear();
  room.rematchStatus = null;
}

// ─── WebSocket message handler ────────────────────────────────────────────────

async function handleMessage(ws, raw) {
  const client = sockets.get(ws);
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(ws, { type: "error", message: "Message must be valid JSON." });
    return;
  }

  // ── Not yet authenticated: expect { type:"join", name:"…" } ────────────────
  if (!client.playerId) {
    if (msg.type !== "join") {
      send(ws, { type: "error", message: 'Send { type:"join", name:"…" } first.' });
      return;
    }

    const name = (typeof msg.name === "string" ? msg.name.trim() : "").slice(0, 20) || "Player";
    const room = rooms.get(client.code);

    if (!room) {
      send(ws, { type: "error", message: "Match not found. The code may have expired." });
      ws.close(1008, "Room not found");
      return;
    }
    const token = typeof msg.token === "string" ? msg.token : null;
    let player = token ? room.players.find((candidate) => candidate.token === token) : null;
    if (token && !player) {
      send(ws, { type: "error", message: "This reconnect session is invalid. Start a new match." });
      ws.close(1008, "Invalid reconnect session");
      return;
    }

    if (!player) {
      if (room.players.length >= 2) {
        send(ws, { type: "error", message: "This match is already full." });
        ws.close(1008, "Room full");
        return;
      }
      const mark = room.players.length === 0 ? "X" : "O";
      player = {
        id: `${mark}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name,
        mark,
        token: randomBytes(32).toString("hex"),
      };
      room.players.push(player);
    }

    const previousSocket = room.clients.get(player.id);
    if (previousSocket && previousSocket !== ws) previousSocket.close(4001, "Session reconnected");

    room.clients.set(player.id, ws);
    client.playerId = player.id;
    client.room     = room;
    touchRoom(room);

    if (room.players.length === 2) room.status = "playing";
    broadcast(room);
    return;
  }

  // ── Authenticated ──────────────────────────────────────────────────────────
  const { room } = client;

  if (msg.type === "move") {
    if (room.status !== "playing") {
      send(ws, { type: "error", message: "The game has not started yet." });
      return;
    }
    const player = room.players.find((p) => p.id === client.playerId);
    const result = makeTurn(room.board, msg.index, player.mark, room.currentPlayer);
    if (result.error) {
      send(ws, { type: "error", message: result.error });
      return;
    }
    room.board = result.board;
    touchRoom(room);
    if (getWinner(room.board) || isDraw(room.board)) {
      room.status = "finished";
    } else {
      room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
    }
    broadcast(room);
    return;
  }

  if (msg.type === "rematch-vote") {
    if (room.status !== "finished" || !isDraw(room.board)) {
      send(ws, { type: "error", message: "A rematch vote is only available after a draw." });
      return;
    }
    if (typeof msg.accept !== "boolean") {
      send(ws, { type: "error", message: "Choose whether to accept the rematch." });
      return;
    }
    if (room.rematchStatus === "declined") {
      send(ws, { type: "error", message: "The rematch was declined." });
      return;
    }

    room.rematchVotes.set(client.playerId, msg.accept);
    if (!msg.accept) {
      room.rematchStatus = "declined";
    } else if (room.players.every((player) => room.rematchVotes.get(player.id) === true)) {
      startNextRound(room);
    } else {
      room.rematchStatus = "waiting";
    }
    touchRoom(room);
    broadcast(room);
    return;
  }

  if (msg.type === "new-round") {
    if (room.status !== "finished") {
      send(ws, { type: "error", message: "The round is not finished yet." });
      return;
    }
    if (isDraw(room.board)) {
      send(ws, { type: "error", message: "Both players must agree to a rematch after a draw." });
      return;
    }
    startNextRound(room);
    touchRoom(room);
    broadcast(room);
    return;
  }

  send(ws, { type: "error", message: "Unknown message type." });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

async function readBody(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error("Request body too large.");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url  = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  try {
    // Health check
    if (req.method === "GET" && path === "/health") {
      json(200, { ok: true });
      return;
    }

    // Create a new room
    if (req.method === "POST" && path === "/room/create") {
      const code = randomCode();
      const room = freshRoom(code);
      rooms.set(code, room);
      touchRoom(room);
      json(200, { code });
      return;
    }

    // Validate a join code before opening a WebSocket
    if (req.method === "POST" && path === "/room/join") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        json(e.status ?? 400, { error: e.message });
        return;
      }
      const code = typeof body.code === "string" ? body.code.toUpperCase().trim() : "";
      const room = rooms.get(code);
      if (!room)                   { json(404, { error: "Match code not found. Check the code and try again." }); return; }
      if (room.players.length >= 2) { json(409, { error: "This match is already full." }); return; }
      json(200, { ok: true });
      return;
    }

    // Static files
    const file = req.method === "GET" ? files.get(path) : undefined;
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const content = await readFile(resolve(root, file[0]));
    res.writeHead(200, { "Content-Type": file[1] });
    res.end(content);
  } catch (err) {
    console.error(`${req.method} ${path} error:`, err);
    json(err.status ?? 500, { error: "Server error." });
  }
});

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

httpServer.on("upgrade", (req, socket, head) => {
  const url  = new URL(req.url ?? "/", "http://localhost");
  const code = (url.searchParams.get("code") ?? "").toUpperCase();

  if (url.pathname !== "/realtime" || !/^[A-Z0-9]{6}$/.test(code)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(ws, { code, playerId: null, room: null });
    wss.emit("connection", ws);
  });
});

wss.on("connection", (ws) => {
  // Give the client 15 seconds to send a join message
  const joinTimeout = setTimeout(() => {
    send(ws, { type: "error", message: "Timed out waiting for join." });
    ws.close(1008, "Join timeout");
  }, 15_000);

  ws.on("message", (raw) => {
    void handleMessage(ws, raw).finally(() => clearTimeout(joinTimeout));
  });

  ws.on("close", () => {
    clearTimeout(joinTimeout);
    const client = sockets.get(ws);
    if (!client?.room) return;
    const { room } = client;
    if (room.clients.get(client.playerId) === ws) {
      room.clients.delete(client.playerId);
      broadcast(room);
    }
  });

  ws.on("error", (err) => console.error("WebSocket error:", err));
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(port, () => {
  console.log(`Three in a Row → http://localhost:${port}`);
});
