# Changelog

## Unreleased

## 0.1.0

First release.

- Play against the Lichess AI (levels 1-8) as White, Black or a random color. The agent asks for your color when you don't give one.
- Start from any of the ~3,800 named openings in the Lichess opening list (`opening` on `new_game`, `find_openings` to search).
- A text board after every move, from your side, with the last move marked. Chess symbols by default, letters with `CHESS_BOARD_STYLE=letters`.
- Moves in SAN, UCI or loose spellings (`nf3`, `g1-f3`, `0-0`); illegal moves are refused with the legal ones listed.
- Sign in with Lichess in the browser (OAuth with PKCE, no app registration). The token is kept in the macOS Keychain, or a file only you can read elsewhere. `LICHESS_TOKEN` works too.
- Follows Lichess's API rules: one request at a time, a full minute's pause after a 429, retries for network and server errors, and a move whose answer was lost is never played twice.
- `takeback`, `resign`, `list_games`, `show_board`, `lichess_status`, `lichess_logout`.
- Updates itself from GitHub releases.
- Needs Node.js 22.12 or later.
