# VicBot

A personal agent platform. You talk to one host that is always ready; the work runs in the background on coding-agent CLIs, gets checked by a different agent, and comes back as a short report.

- **Always ready.** The composer is never disabled and no message is rejected. A message to a busy task is queued as a note for its next turn (you can withdraw it); tick "stop and redirect" to interrupt. "status" is answered from the store, without a model call.
- **Three harnesses, picked by manifest.** pi for quick work, codex for exploratory and complex work, omp for heavy work. The mapping lives in `harnesses/*.json`, not in code.
- **Verdicts, not guesses.** Every run ends by filing `.vicbot/verdict.json` (or a `<verdict>` tag when it can't write files): pass, rework, fail, human, overflow or handoff.
- **The worker never checks itself.** Deterministic checks run first, then an independent review on another harness, then you, if the contract says so.
- **Fixed templates per bot.** Each role (explore, build, operate, verify, chair, tune) has a frozen protocol and a tunable policy. Generation 1 is frozen on first boot. The keeper later proposes small policy edits that go on trial and are promoted only when they pass more often. Every run records its template hash.
- **Cache-friendly context.** A stable prefix (no ids, no clock) keeps prompt caches warm; the clock and new messages go in the volatile tail. Cached tokens are recorded per run and shown as a cache-hit rate.

The full design is in [`docs/vicbot-design.html`](docs/vicbot-design.html).

## Setup

Requires [Bun](https://bun.sh) 1.3 or later, plus any of these CLIs on `PATH`, each signed in:

| Harness | Install | Used for |
|---|---|---|
| `pi` | pi coding agent (1.5+) | quick tasks on any route |
| `codex` | Codex CLI (0.170+) | explore and operate at standard effort, planning (chair), reviews |
| `omp` | omp (19+) | build at standard and deep effort, and any deep task |

```sh
bun install
bun start            # or: bun src/cli.ts serve
```

Open http://127.0.0.1:7420. VicBot keeps its data in `~/.vicbot/` (`VICBOT_HOME` to change): `vicbot-v1.db`, `memory/`, `sessions/`, and scratch working dirs under `work/`.

Missing harnesses degrade instead of breaking: when only pi is installed, everything runs on pi and reviews run in a fresh pi session. When none is installed, tasks wait in "needs route" and say why.

## Using it

Type in the host chat. The router picks a route (explore, build or operate), an effort (quick, standard or deep) and a shape:

- `@codex …` (or `@pi`, `@omp`) designates a harness. A designated task never escalates.
- "break it down", "in parallel" or "split this into" starts an orchestrated task: a chair run plans up to 6 parts with dependencies, the parts run, and the parent is verified as a whole.
- When the router is unsure, a card asks you where the task should go.

Click a task to see its timeline, runs (harness, template hash, cache hit), checks, contract and notes. Edit the contract to add checks: `cmd`, `test`, `file`, `judge` or `human`.

What happens on its own:

- A pass with named artifacts must change at least one of them.
- A check gets one rework. A second failure, an overflow verdict, or the loop guard tripping twice escalates the task once to a chair.
- An exhausted budget blocks the task with a card to extend it. It never escalates.
- Handoffs carry a brief to another route, go at most 2 hops, never revisit a route, and never raise trust.
- Trust starts at read for explore and workspace for build and operate. Only you can raise it, and full trust needs a full-scope device.

## CLI

```
vic serve | run <text> [--route r --effort e --cwd d --wait] | say <text> [--task id --interrupt]
vic ls | show <id> | cancel <id> | route <text> | cards | answer <card> [option] [--text t]
vic pair [--scope full|standard|notify] | harness list | templates [reseed <role>] | keeper
```

Run `bun link` to get `vic` on your PATH. The CLI talks to `/v1`; point it at another machine with `VICBOT_URL` and `VICBOT_TOKEN`.

## Other devices

The server binds to 127.0.0.1. The browser and CLI on that machine are trusted automatically. To reach it from your phone or laptop, run it on a private network (for example, Tailscale) and never on the public internet:

```sh
VICBOT_HOST=100.x.y.z VICBOT_ALLOWED_HOSTS=vicbot.your-tailnet.ts.net:7420 bun start
vic pair --scope standard     # one-time code, valid 5 minutes
```

Open the page on the device and enter the code. Tokens are stored hashed; revoke devices from the Devices dialog. Scopes:

- **full**: everything.
- **standard**: everything except pairing devices and full trust.
- **notify**: read, and answer questions.

Cards are first-answer-wins across devices.

## Adding a harness

Drop a manifest in `harnesses/`. An `in-process` entry names one of the built-in adapters. A `stdio` entry runs any program that speaks the JSON-lines protocol (`hello` → `ready`, `turn` → `text`/`tool`/`usage`/`done`). `serves` rules and `rank` decide which requests it takes. See `harnesses/codex.json` for the fields.

## Development

```sh
bun test          # the whole flow runs against the null harness (zero capabilities)
bun run typecheck
```

Notes:

- pi and omp have no sandbox. Their read trust is enforced by a read-only tool list; workspace trust relies on the tool list and the working root. codex uses its own sandbox.
- Add `.vicbot/` to the `.gitignore` of repos you point VicBot at; verdict files are written there.

## License

MIT
