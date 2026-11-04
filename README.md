# No-compaction: a pi extension

Adapted from [No-compaction: a Claude Code mod](https://gist.github.com/Tomcc/b7b0f348b1628ad94bdef918e449b330) by [Tommaso Checchi](https://gist.github.com/Tomcc)

When the context fills up, pi normally summarizes the conversation, and the summary loses detail.
This extension skips the summary. It clears the context and points pi at the session's own
transcript file, so it can reread exactly what happened.

It also fixes what the port could not know: pi session logs are *trees*, not linear transcripts, and
the model has no idea how much of its own context it has used after a reset. So the extension gives
pi two tools - one to read the log along the branch it is actually on, one to report real context
usage and to choose its own reset, carrying a handoff note into the fresh context and continuing the
run instead of handing control back to the user.

Requires a pi that can hook `session_before_compact` (the hook that answers a compaction with a
custom summary instead of running the summarizer).

## Install

Put the file below in an extensions folder pi discovers on its own:

```
~/.pi/agent/extensions/no-compaction-pi.ts   # user
.pi/extensions/no-compaction-pi.ts           # project
```

Restart any open sessions (`pi --resume` keeps your history). Pi reports extensions that fail to
load on startup, so that is the whole check.

## Tools

### `context_reset`

- `action: "status"` reports the actual context usage: tokens used, window, the point where the next
  reset fires. This is the cure for guessing usage from the size of the log, which made the model
  wrap up early and leave the machine idle.
- `action: "reset"` with a `handoff` note clears the context at the end of that turn, writes the
  handoff into the new context as an extra message, and asks pi to continue, so work goes on without
  a user present. Only the pointer and the handoff survive, so the handoff must stand on its own;
  call it at a clean break point as the only tool call of a turn.

### `session_log`

- `action: "tree"` lists the roots of the log and marks the branch to continue.
- `action: "entries"` prints one branch oldest-first with the file line numbers to read, capped to
  25 entries at 250 characters by default (max 200 entries at 2000).

## How it works

- Hooks on session start and on every prompt save the transcript path, since that is where pi
  exposes it, and pi fires `session_start` again on reload.
- The `session_before_compact` hook returns a compaction instead of letting the summarizer run, and
  it keeps no entries, so the pointer message is the only thing left in the new context.
- A tool-requested reset goes through the `turn_end` boundary as a retain-none compaction draft plus
  the handoff as a `custom_message`, followed by a continuation request. `ctx.compact()` cannot be
  used for it: manual compaction aborts the running turn first, so the tool only records the request
  and the boundary performs it. `agent_before_settle` is the fallback for a boundary that cannot
  continue.
- The pointer describes the log as a tree (`id`/`parentId`, several roots, file order is append order
  not conversation order) and names the leaf this reset was made on, which is the branch pi continues.
- State lives in the extension closure: the path, the pending handoff, and the reset count, which is
  rebuilt from the active branch on `/tree`, `/resume` and `/reload`. Tool result `details` carry the
  same data, and the pointer compaction entries are marked `details.noCompaction`.
- A footer status shows the real usage, so you can see the model is not actually near the limit.

## Caveats

- Picking up where it left off costs pi a few tool calls to read the log. In return, it gets the real
  history instead of a lossy summary. Reading the log back in spends context, so the tool caps output.
- pi only calls the hook when it has something to summarize. If the projected context is under
  `keepRecentTokens`, or the session is not persisted at all (`--no-session`), no compaction is
  attempted, so the pointer never appears and `context_reset` says so. That is pi's behavior, not the
  extension's.
- A tool-requested reset drops the whole turn it was called in, including its own tool results: the
  handoff is what survives. The tool refuses a reset with an empty handoff for that reason.
- Continuation is requested, not guaranteed: an aborted run suppresses it, and a model that decides
  the work is finished still stops. The pointer tells it not to stop early.
