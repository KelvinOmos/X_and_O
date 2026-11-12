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

async function connect(port, code, name) {
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
  socket.send(JSON.stringify({ type: "join", name }));
  return socket;
}

test("two players join a room and complete a server-validated match", async (t) => {
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
  const xWaiting = await waitForMessage(x, (message) => message.type === "state" && message.status === "waiting");
  assert.equal(xWaiting.yourMark, "X");

  const o = await connect(port, code, "Bisi");
  sockets.push(o);
  const [xReady, oReady] = await Promise.all([
    waitForMessage(x, (message) => message.type === "state" && message.connected === 2),
    waitForMessage(o, (message) => message.type === "state" && message.connected === 2),
  ]);
  assert.equal(xReady.yourMark, "X");
  assert.equal(oReady.yourMark, "O");

  const wrongTurn = waitForMessage(o, (message) => message.type === "error");
  o.send(JSON.stringify({ type: "move", index: 0 }));
  assert.match((await wrongTurn).message, /not your turn/);

  const moves = [
    [x, 0, ["X", null, null, null, null, null, null, null, null]],
    [o, 3, ["X", null, null, "O", null, null, null, null, null]],
    [x, 1, ["X", "X", null, "O", null, null, null, null, null]],
    [o, 4, ["X", "X", null, "O", "O", null, null, null, null]],
    [x, 2, ["X", "X", "X", "O", "O", null, null, null, null]],
  ];
  for (const [socket, index, expectedBoard] of moves) {
    const updatedState = waitForMessage(socket, (message) =>
      message.type === "state" && JSON.stringify(message.board) === JSON.stringify(expectedBoard)
    );
    socket.send(JSON.stringify({ type: "move", index }));
    await updatedState;
  }

  const completed = await Promise.all([
    waitForMessage(x, (message) => message.type === "state" && message.status === "finished"),
    waitForMessage(o, (message) => message.type === "state" && message.status === "finished"),
  ]);
  assert.deepEqual(completed[0].board, ["X", "X", "X", "O", "O", null, null, null, null]);
  assert.equal(completed[0].winner, "X");
  assert.equal(completed[1].winner, "X");
});

test("the other player starts an agreed rematch after a draw", async (t) => {
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
  await waitForMessage(x, (message) => message.type === "state" && message.status === "waiting");

  const o = await connect(port, code, "Bisi");
  sockets.push(o);
  await waitForMessage(x, (message) => message.type === "state" && message.connected === 2);
  await waitForMessage(o, (message) => message.type === "state" && message.connected === 2);

  const moves = [
    [x, 0],
    [o, 1],
    [x, 2],
    [o, 4],
    [x, 3],
    [o, 5],
    [x, 7],
    [o, 6],
    [x, 8],
  ];
  for (const [socket, index] of moves) {
    const updatedState = waitForMessage(socket, (message) =>
      message.type === "state" && message.board[index] !== null
    );
    socket.send(JSON.stringify({ type: "move", index }));
    await updatedState;
  }

  const drawn = await waitForMessage(x, (message) =>
    message.type === "state" && message.status === "finished" && message.winner === "draw"
  );
  assert.deepEqual(drawn.board, ["X", "O", "X", "X", "O", "O", "O", "X", "X"]);

  const xRematch = waitForMessage(x, (message) =>
    message.type === "state" && message.rematchStatus === "waiting"
  );
  x.send(JSON.stringify({ type: "rematch-vote", accept: true }));
  await xRematch;

  const nextRound = waitForMessage(o, (message) =>
    message.type === "state" && message.status === "playing" && message.currentPlayer === "O" &&
      message.board.every((cell) => cell === null)
  );
  o.send(JSON.stringify({ type: "rematch-vote", accept: true }));
  const rematchState = await nextRound;
  assert.equal(rematchState.currentPlayer, "O");

  const xNotTurn = waitForMessage(x, (message) => message.type === "error");
  x.send(JSON.stringify({ type: "move", index: 0 }));
  assert.match((await xNotTurn).message, /not your turn/);

  const oMoved = waitForMessage(x, (message) => message.type === "state" && message.board[0] === "O");
  o.send(JSON.stringify({ type: "move", index: 0 }));
  const updatedState = await oMoved;
  assert.equal(updatedState.currentPlayer, "X");
});
