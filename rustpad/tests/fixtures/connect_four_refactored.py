"""
Part 1 — Connect Four

Implement the core logic for Connect Four.
- Board is 6 rows x 7 columns. Players alternate, starting with "x".
- A piece dropped in a column lands in the lowest empty row.
- 4 in a row wins: horizontal, vertical, or diagonal.
- Board full with no winner = draw.
- Dropping into a full column, an out-of-range column, or after the game ends is an error (raise).
"""

from enum import Enum, auto


class Direction(Enum):
    VERTICAL = auto()
    HORIZONTAL = auto()
    DIAGONAL = auto()

class ConnectFour:
    def __init__(self):
        self.board = [[None for _ in range(7)] for _ in range(6)]

    def drop_piece(self, column: int) -> str:
        """Returns "x wins", "o wins", "draw", or "continue"."""
        
        landing_row = None
        for row in range(len(self.board)):
            if self.board[row][column] is None:
                landing_row = row
                break
        
        if (
            test_window(k, landing_row, column, Direction.VERTICAL)
            or test_window(k, landing_row, column, Direction.HORIZONTAL)
            or test_window(k, landing_row, column, Direction.DIAGONAL)
        ):
            return "x win"

    def test_window(self, k, row, column, direction):
        if direction == Direction.VERTICAL:
            if self.count_in_line(k, row, column, direction):
                return True
        elif direction == Direction.HORIZONTAL:
            if self.count_in_line(k, row, column, direction):
                return True
        elif direction == Direction.DIAGONAL:
            pass

        return True

    def count_in_line(self, k, row, column, direction):
        """Whether the run through (row, column) along `direction` reaches k."""
        d_row, d_col = (1, 0) if direction == Direction.VERTICAL else (0, 1)
        marker = self.board[row][column]

        before = 0
        r, c = row - d_row, column - d_col
        while 0 <= r < len(self.board) and 0 <= c < len(self.board[r]) and self.board[r][c] == marker:
            before += 1
            r, c = r - d_row, c - d_col

        after = 0
        r, c = row + d_row, column + d_col
        while 0 <= r < len(self.board) and 0 <= c < len(self.board[r]) and self.board[r][c] == marker:
            after += 1
            r, c = r + d_row, c + d_col

        return before + after >= k
       
            


#main playing loop
def play(game, moves):
    for i, m in enumerate(moves, 1):
        result = game.drop_piece(m)
        if result != "continue":
            return f"{result} (move {i})"
    return f"continue (move {len(moves)})"



#Test cases
def test_horizontal():
    # x connects four pieces horizontally along the bottom row.
    result = play(ConnectFour(), [3, 3, 2, 2, 1, 1, 0])
    assert result == "x wins (move 7)", f"Got: {result}"


def test_vertical():
    # x stacks four pieces vertically in the same column.
    result = play(ConnectFour(), [0, 1, 0, 1, 0, 1, 0])
    assert result == "x wins (move 7)", f"Got: {result}"


def test_diagonal_up():
    # x connects four pieces diagonally upward to the right (/).
    result = play(ConnectFour(), [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])
    assert result == "x wins (move 11)", f"Got: {result}"


def test_diagonal_down():
    # x connects four pieces diagonally upward to the left (\).
    result = play(ConnectFour(), [6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3])
    assert result == "x wins (move 11)", f"Got: {result}"


def test_o_wins():
    # O connects four pieces vertically in column 1 on move 8.
    result = play(ConnectFour(), [0, 1, 0, 1, 2, 1, 2, 1])
    assert result == "o wins (move 8)", f"Got: {result}"

def test_full_column():
    # A column holds at most six pieces.
    # Dropping a seventh piece must raise an exception.
    game = ConnectFour()
    play(game, [0, 0, 0, 0, 0, 0])

    try:
        game.drop_piece(0)
    except Exception:
        return

    assert False, "Expected an exception for a full column"


def test_draw():
    # All 42 cells fill without either player winning.
    moves = [
        1, 6, 0, 0, 0, 3, 6, 2, 3, 3, 4, 6, 5, 1,
        3, 0, 2, 5, 6, 4, 1, 2, 5, 3, 4, 1, 3, 6,
        1, 1, 2, 2, 0, 4, 2, 5, 6, 0, 5, 5, 4, 4
    ]
    result = play(ConnectFour(), moves)
    assert result == "draw (move 42)", f"Got: {result}"


def main():
    tests = [
        test_horizontal,
        test_vertical,
        test_diagonal_up,
        test_diagonal_down,
        test_full_column,
        test_draw,
    ]

    passed = 0

    for test in tests:
        try:
            test()
            print(f"PASS: {test.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL: {test.__name__} -> {type(e).__name__}: {e}")

    print(f"\nResults: {passed}/{len(tests)} tests passed")


if __name__ == "__main__":
    main()
