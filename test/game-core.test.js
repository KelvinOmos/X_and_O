import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_BOARD, getWinner, getWinningLine, isDraw, makeMove, makeTurn } from "../game-core.js";

test("starts with an empty board and no result", () => {
  assert.equal(EMPTY_BOARD.length, 9);
  assert.equal(getWinner(EMPTY_BOARD), null);
  assert.equal(isDraw(EMPTY_BOARD), false);
});

test("accepts a move without mutating the original board", () => {
  const result = makeMove([...EMPTY_BOARD], 4, "X");
  assert.equal(result.error, null);
  assert.equal(result.board[4], "X");
  assert.equal(EMPTY_BOARD[4], null);
});

test("rejects occupied and out-of-range cells", () => {
  const board = ["X", null, null, null, null, null, null, null, null];
  assert.match(makeMove(board, 0, "O").error, /already taken/);
  assert.match(makeMove(board, 9, "O").error, /Choose a square/);
});

test("detects all rows, columns, and diagonals as wins", () => {
  const winningBoards = [
    ["X", "X", "X", null, null, null, null, null, null],
    [null, null, null, "O", "O", "O", null, null, null],
    [null, null, null, null, null, null, "X", "X", "X"],
    ["O", null, null, "O", null, null, "O", null, null],
    [null, "X", null, null, "X", null, null, "X", null],
    [null, null, "O", null, null, "O", null, null, "O"],
    ["X", null, null, null, "X", null, null, null, "X"],
    [null, null, "O", null, "O", null, "O", null, null]
  ];

  for (const board of winningBoards) {
    assert.equal(getWinner(board), board.find(Boolean));
    assert.equal(isDraw(board), false);
    assert.ok(getWinningLine(board));
  }
});

test("returns the exact winning squares and no line before a win", () => {
  assert.deepEqual(getWinningLine(["X", "O", "X", null, "X", "O", null, null, "X"]), [0, 4, 8]);
  assert.equal(getWinningLine(EMPTY_BOARD), null);
});

test("detects a full board without a winner as a draw", () => {
  assert.equal(isDraw(["X", "O", "X", "X", "O", "O", "O", "X", "X"]), true);
});

test("does not allow moves after a win or draw", () => {
  const won = ["X", "X", "X", "O", "O", null, null, null, null];
  const drawn = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
  assert.match(makeMove(won, 5, "X").error, /already over/);
  assert.match(makeMove(drawn, 8, "O").error, /already over/);
});

test("rejects an invalid player mark", () => {
  assert.throws(() => makeMove([...EMPTY_BOARD], 0, "Y"), /Player must be X or O/);
});

test("only accepts a move from the player whose turn it is", () => {
  const board = [...EMPTY_BOARD];
  assert.match(makeTurn(board, 0, "O", "X").error, /not your turn/);
  const result = makeTurn(board, 0, "X", "X");
  assert.equal(result.error, null);
  assert.equal(result.board[0], "X");
});
