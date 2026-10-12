# chess-mcp

Play chess against the [Lichess](https://lichess.org) AI from inside your AI agent: Claude Code, Claude Desktop, Cursor, Codex or any other [MCP](https://modelcontextprotocol.io) client.

Tell your agent "let's play chess". It asks which color you want, starts a game on Lichess and shows the board after every move. You say your moves ("knight to f3", "Nf3", "castle"), and the agent plays them and shows the AI's reply.

```text
You played c3. The Lichess AI played Nf6.

   a  b  c  d  e  f  g  h
8  ♜  ·  ♝  ♛  ♚  · [·] ♜  8
7  ♟  ♟  ♟  ♟  ·  ♟  ♟  ♟  7
6  ·  ·  ♞  ·  · [♞] ·  ·  6
5  ·  ·  ♝  ·  ♟  ·  ·  ·  5
4  ·  ·  ♗  ·  ♙  ·  ·  ·  4
3  ·  ·  ♙  ·  ·  ♘  ·  ·  3
2  ♙  ♙  ·  ♙  ·  ♙  ♙  ♙  2
1  ♖  ♘  ♗  ♕  ♔  ·  ·  ♖  1
   a  b  c  d  e  f  g  h

White ♔♕♖♗♘♙   Black ♚♛♜♝♞♟

Started from: Italian Game (C50): 1. e4 e5 2. Nf3 Nc6 3. Bc4
Moves: 3... Bc5 4. c3 Nf6
Opening: Italian Game: Classical Variation (C54)
Your move (White).
Lichess AI level 3 · Game: https://lichess.org/AbCd1234
```

- **Pick your side.** White, Black or random. If you don't say, the agent asks.
- **Pick a strength.** The Lichess AI levels 1 (beginner) to 8 (strongest). The default is 3.
- **Pick an opening.** For example "Play the Najdorf against me", "I want to practice the London" or "start from the Caro-Kann". The game starts from that opening's main position. The list is the [Lichess opening list](https://github.com/lichess-org/chess-openings), about 3,800 named lines.
- **See the board every turn.** It's drawn in the chat, with the last move in [brackets]. Every game is also a real Lichess game, so you can keep `lichess.org/<game>` open in a browser tab.
- **Nothing to host.** The server runs on your computer and talks to Lichess directly. You need a free Lichess account.

## Quick start

You need [Node.js](https://nodejs.org) 20 or later, git and a free [Lichess account](https://lichess.org/signup).

**1. Download and build it:**

```sh
git clone https://github.com/swlittles/chess-mcp.git ~/chess-mcp
cd ~/chess-mcp
npm ci                 # installs the exact locked dependencies and builds dist/index.js
```

**2. Add it to your agent.** Use absolute paths.

Claude Code:

```sh
claude mcp add chess --scope user -- node $HOME/chess-mcp/dist/index.js
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows), Cursor (`~/.cursor/mcp.json`) and other clients that use the `mcpServers` format:

```json
{
  "mcpServers": {
    "chess": {
      "command": "node",
      "args": ["/Users/you/chess-mcp/dist/index.js"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.chess]
command = "node"
args = ["/Users/you/chess-mcp/dist/index.js"]
```

**3. Connect your Lichess account.** You can let the agent do it: the first time you start a game, it shows you a Lichess link and opens it in your browser. Sign in to Lichess and click **Authorize**, then tell the agent you're done. You can also do it from a terminal first:

```sh
node ~/chess-mcp/dist/index.js --login
```

**4. Play.** Ask your agent: *"Let's play chess. I'll take Black, level 4, and play the Sicilian against me."*

## How the Lichess connection works

Signing in uses Lichess's standard OAuth flow. Lichess asks you to approve two permissions:

- **Create, accept, decline challenges** (`challenge:write`), to start games against the AI.
- **Play games with the board API** (`board:play`), to send your moves.

The token can't read your email or change your account settings, and the server only uses it to start games against the AI and play the moves you give it. The token lasts about a year. It's stored in the **macOS Keychain**, or on Linux and Windows in `~/.chess-mcp/lichess-token`, which only your user can read. It never leaves your computer except to talk to lichess.org.

- Check the connection: `node ~/chess-mcp/dist/index.js --status`, or ask the agent.
- Sign out: `node ~/chess-mcp/dist/index.js --logout`. This revokes the token on Lichess and deletes it locally. You can also revoke it at [lichess.org/account/oauth/token](https://lichess.org/account/oauth/token).
- **Prefer a personal token?** [Create one with the two permissions](https://lichess.org/account/oauth/token/create?scopes[]=challenge:write&scopes[]=board:play&description=chess-mcp) and set it as `LICHESS_TOKEN` in the MCP config's `env`. The server then never asks you to sign in.

## Things to know

- **Games are casual and are saved to your Lichess account.** Games against the AI are never rated. They appear in your Lichess game history and have no clock, so you can take as long as you like or come back to a game later ("show me my chess games").
- **The agent won't help you play.** Lichess's [fair-play rules](https://lichess.org/page/fair-play) forbid outside help, so while a game is in progress the agent won't suggest moves or evaluate the position. Ask it for an analysis once the game is over.
- **The AI chooses its own moves.** Lichess doesn't let a client choose the AI's moves. That's why an opening is played by *starting* from its position, not by making the AI play into it.
- **Rate limits.** The server sends Lichess one request at a time. If Lichess still asks it to slow down, it waits the full minute Lichess asks for and tells you, instead of retrying. Requests that fail on a network or server error are retried. A move whose answer was lost is checked before it's sent again, so it's never played twice.

## Updates

**Updates are automatic.** When your agent starts the server, the server checks GitHub for a newer release (at most every 30 minutes) and installs it in the background. The update is used from the next time the agent starts the server. It only fast-forwards a clean clone, and it rolls back if an install or build fails.

- Update now: `node ~/chess-mcp/dist/index.js --update`
- Turn it off: set `CHESS_AUTO_UPDATE=0` in the MCP config's `env`.
- Follow the main branch instead of releases: `CHESS_UPDATE_CHANNEL=main`.
- To update by hand: `git pull && npm ci`. Use `npm ci`, not `npm install`, which rewrites the lockfile.

## Configuration

All optional, set in the MCP config's `env`:

| Variable | Default | |
|---|---|---|
| `LICHESS_TOKEN` | | A personal API token instead of signing in through the browser |
| `CHESS_DEFAULT_LEVEL` | `3` | The AI's strength (1-8) when you don't name one |
| `CHESS_BOARD_STYLE` | `unicode` | `letters` draws pieces as `KQRBNP` (White) and `kqrbnp` (Black), for fonts where the chess symbols misalign |
| `CHESS_OPEN_BROWSER` | `1` | `0`: don't open the sign-in page automatically; only show the link |
| `CHESS_MCP_HOME` | `~/.chess-mcp` | Where game notes (and, outside macOS, the token) are kept |
| `CHESS_AUTO_UPDATE` | `1` | `0` turns off automatic updates |
| `CHESS_UPDATE_CHANNEL` | `release` | `main` follows the main branch |

## Tools

| Tool | What it does |
|---|---|
| `new_game` | Starts a game: `color` (required), `level`, `opening` |
| `make_move` | Plays your move and returns the AI's reply with the board |
| `show_board` | The current board, moves and whose turn it is |
| `list_games` | Your games against the AI that are in progress |
| `find_openings` | Searches openings by name or ECO code |
| `takeback` | Takes back the last move pair, if the AI agrees |
| `resign` | Resigns (or aborts a game that hasn't started) |
| `lichess_login`, `lichess_status`, `lichess_logout` | Connect, check or disconnect your Lichess account |

## Development

```sh
npm ci
npm test                 # unit tests and end-to-end tests over MCP against a fake Lichess
npm run build && node scripts/call-tool.mjs show_board '{}'   # one tool against real Lichess
npm run openings:update  # refresh data/openings.tsv from lichess-org/chess-openings
```

## License

MIT. The opening list in `data/openings.tsv` comes from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0). This project isn't affiliated with Lichess. If you enjoy playing there, consider [supporting Lichess](https://lichess.org/patron).
