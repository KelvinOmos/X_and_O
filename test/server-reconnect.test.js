import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Game server did not start.");
}

function waitForMessage(socket, predicate) {
  const existing = socket.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("game-message", onMessage);
      reject(new Error(`Timed out waiting for game message: ${JSON.stringify(socket.messages)}`));
    }, 5000);
    function onMessage(message) {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("game-message", onMessage);
      resolve(message);
    }
    socket.on("game-message", onMessage);
  });
}

async function connect(port, code, name, token = null) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime?code=${code}`);
  socket.messages = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    socket.messages.push(message);
    socket.emit("game-message", message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "join", name, token }));
  return socket;
}

test("reconnect restores the same player, board, and turn", async (t) => {
  const port = await freePort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    server.kill();
  });
  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/room/create`, { method: "POST" });
  assert.equal(response.status, 200);
  const { code } = await response.json();

  const x = await connect(port, code, "Tola");
  sockets.push(x);
  const xJoined = await waitForMessage(x, (message) => message.type === "state" && message.yourMark === "X");

  const o = await connect(port, code, "Bisi");
  sockets.push(o);
  const oJoined = await waitForMessage(o, (message) => message.type === "state" && message.yourMark === "O");
  await Promise.all([
    waitForMessage(x, (message) => message.type === "state" && message.connected === 2),
    waitForMessage(o, (message) => message.type === "state" && message.connected === 2),
  ]);
  assert.match(xJoined.reconnectToken, /^[a-f0-9]{64}$/);
  assert.match(oJoined.reconnectToken, /^[a-f0-9]{64}$/);
  assert.notEqual(xJoined.reconnectToken, oJoined.reconnectToken);

  const xMoved = waitForMessage(o, (message) => message.type === "state" && message.board[4] === "X");
  x.send(JSON.stringify({ type: "move", index: 4 }));
  await xMoved;

  const disconnected = waitForMessage(o, (message) => message.type === "state" && message.connected === 1);
  x.close();
  await disconnected;

  const reconnectedX = await connect(port, code, "Tola", xJoined.reconnectToken);
  sockets.push(reconnectedX);
  const restored = await waitForMessage(
    reconnectedX,
    (message) => message.type === "state" && message.connected === 2 && message.yourMark === "X"
  );
  assert.equal(restored.board[4], "X");
  assert.equal(restored.currentPlayer, "O");

  const continued = waitForMessage(reconnectedX, (message) => message.type === "state" && message.board[0] === "O");
  o.send(JSON.stringify({ type: "move", index: 0 }));
  const nextState = await continued;
  assert.equal(nextState.board[4], "X");
  assert.equal(nextState.currentPlayer, "X");
});
