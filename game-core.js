export const EMPTY_BOARD = Object.freeze(Array(9).fill(null));

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

export function getWinningLine(board) {
  const line = LINES.find(([a, b, c]) =>
    board[a] && board[a] === board[b] && board[a] === board[c]
  );
  return line ? [...line] : null;
}

export function getWinner(board) {
  const line = getWinningLine(board);
  return line ? board[line[0]] : null;
}

export function isDraw(board) {
  return !getWinner(board) && board.every(Boolean);
}

export function makeMove(board, index, player) {
  if (!Array.isArray(board) || board.length !== 9) {
    throw new TypeError("A tic-tac-toe board must contain exactly 9 cells.");
  }
  if (player !== "X" && player !== "O") {
    throw new TypeError("Player must be X or O.");
  }
  if (!Number.isInteger(index) || index < 0 || index >= 9) {
    return { board, error: "Choose a square on the board." };
  }
  if (getWinner(board) || isDraw(board)) {
    return { board, error: "This game is already over." };
  }
  if (board[index] !== null) {
    return { board, error: "That square is already taken." };
  }

  const nextBoard = [...board];
  nextBoard[index] = player;
  return { board: nextBoard, error: null };
}

export function makeTurn(board, index, player, currentPlayer) {
  if (player !== currentPlayer) {
    return { board, error: "It is not your turn." };
  }
  return makeMove(board, index, player);
}
