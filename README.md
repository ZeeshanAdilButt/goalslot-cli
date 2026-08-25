# GoalSlot CLI

Track time, check what is scheduled, and control the running timer from your terminal.

Talks to [GoalSlot](https://www.goalslot.io). Node 20 or newer.

## Install

```bash
npm install -g goalslot
```

Or run it without installing:

```bash
npx goalslot today
```

## Log in

```bash
goalslot login
```

This binds a loopback port, opens your browser to approve the request, and stores a
credential scoped to this machine. Nothing is typed into the terminal.

On a server, over SSH, or anywhere without a browser, it falls back to a device code
automatically:

```bash
goalslot login --device
```

You get a short code, open `https://www.goalslot.io/cli/authorize` on any device, type it,
and approve. `--no-device` turns the fallback off and fails instead.

Revoke a machine any time from **Settings, CLI tokens** at
<https://www.goalslot.io/dashboard/settings?tab=cli>. Revocation takes effect within about a
minute. Changing your password revokes every CLI token.

## Commands

| Command | What it does |
| --- | --- |
| `goalslot login` | Authorize this machine in your browser |
| `goalslot logout` | Revoke this machine's token and delete the local credential |
| `goalslot whoami` | Show who this machine is authenticated as |
| `goalslot status` | Show what is tracking right now |
| `goalslot start <task...>` | Start tracking time |
| `goalslot stop` | Stop tracking and log the time entry |
| `goalslot today` | Today's schedule, what has been logged, what is running |
| `goalslot tokens` | List, rename or revoke CLI tokens |
| `goalslot mcp` | Run the GoalSlot MCP server over stdio |

Every command takes `--json` for machine-readable output, and `--help`.

```bash
goalslot start write the readme
goalslot status
goalslot stop --notes "first draft done"
```

`start` refuses to clobber a running timer. Use `--take-over` to replace it, which discards
the elapsed time rather than logging it, or `goalslot stop` first to keep it. `stop --discard`
throws a session away without writing an entry, for the accidental start.

Manage machines from the terminal instead of the web UI:

```bash
goalslot tokens list
goalslot tokens rename <id> "work laptop"
goalslot tokens revoke <id>
goalslot tokens revoke-all
```

## Using it with the MCP server

The CLI and the [GoalSlot MCP server](https://github.com/ZeeshanAdilButt/goalslot-mcp) read the
same credential file, so **`goalslot login` authenticates both**. Log in once and the MCP server
picks the credential up with no separate auth step.

```bash
npm install -g goalslot goalslot-mcp
goalslot login
```

Then register it with Claude Code:

```bash
claude mcp add goalslot -- goalslot mcp
```

Any client that speaks stdio works; point it at `goalslot mcp` as the command.

`goalslot mcp` hands the server your config directory, not a token, so the server reads and
refreshes the shared credential itself. A token passed through the environment would expire an
hour later with no way to recover.

If the server is not installed, `goalslot mcp` says so and exits rather than failing silently.
The launcher resolves `goalslot-mcp` first and `@goalslot/mcp` second, so it keeps working
whichever name the package is published under.

## Credentials

| Platform | Location |
| --- | --- |
| Linux, macOS | `${XDG_CONFIG_HOME:-$HOME/.config}/goalslot/credentials.json` |
| Windows | `%APPDATA%\goalslot\credentials.json` |

Written atomically, mode `0600` on POSIX. On Windows the mode is a no-op and the protection is
the per-user ACL on `%APPDATA%`; the CLI does not pretend otherwise, and warns on POSIX if the
file is group or world readable.

The access token lasts an hour and is refreshed automatically. The refresh token lasts 90 days,
rotating on every use, with a hard 365 day ceiling. Presenting an already-rotated refresh token
revokes the whole credential, which is the correct response to a stolen one; if that happens,
run `goalslot login` again.

### Environment

| Variable | Effect |
| --- | --- |
| `GOALSLOT_CONFIG_DIR` | Override the credential directory |
| `GOALSLOT_API_URL` | Point at a different API, for local development |
| `GOALSLOT_TOKEN` | Use this access token and ignore the file. Disables refresh, so it is for CI |
| `NO_COLOR` | Disable colour |
| `GOALSLOT_DEBUG=1` | Print stack traces on failure |

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
