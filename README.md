# No-compaction: a pi extension

Adapted from [No-compaction: a Claude Code mod](https://gist.github.com/Tomcc/b7b0f348b1628ad94bdef918e449b330) by [Tommaso Checchi](https://gist.github.com/Tomcc)

When the context fills up, pi normally summarizes the conversation, and the summary loses
detail. This extension skips the summary. It clears the context and points pi at the session's
own transcript file, so it can reread exactly what happened.

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

## `no-compaction-pi.ts`

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Kept in the extension closure so a reload mid-session still knows where the log is.
let transcriptPath = "";

function resumeMessage(path: string): string {
  return (
    "No-compaction workflow: your context filled up and was cleared. " +
    `Read ${path} like any normal file to find what you were working on, ` +
    "and resume as seamlessly as possible from where you left off.\n\n" +
    "Tips:\n" +
    "- Each line is one JSON message, some with huge tool results: never cat or tail it raw, " +
    "cap each block to a few hundred chars.\n" +
    "- The end shows where you stopped; the first user messages show the goal.\n" +
    "- The last few lines are this new request, so skip them."
  );
}

function recordPath(ctx: ExtensionContext): void {
  const path = ctx.sessionManager.getSessionFile();
  if (path) transcriptPath = path;
}

export default function (pi: ExtensionAPI) {
  // pi exposes the transcript path through the session manager; record it as early and as
  // often as we can. session_start fires again on reload, so a reload refills it right away.
  pi.on("session_start", async (_event, ctx) => {
    recordPath(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    recordPath(ctx);
  });

  // Nothing to precompute: the replacement is free.
  pi.on("session_before_compact", async (event, ctx) => {
    // A compaction that keeps nothing: the summary slot holds the pointer message, so the
    // nullish firstKeptEntryId makes pi record the entry's own id and nothing else survives.
    const path = transcriptPath;
    if (path === "") {
      ctx.ui.notify("no-compaction: transcript path unknown, using normal compaction", "warning");
      return;
    }

    try {
      return {
        compaction: {
          summary: resumeMessage(path),
          firstKeptEntryId: null as unknown as string,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch {
      // Never end up with an empty context: fall back to normal compaction.
      return;
    }
  });
}
```

## How it works

- Hooks on session start and on every prompt save the transcript path, since that is where pi
  exposes it, and pi fires `session_start` again on reload.
- The `session_before_compact` hook returns a compaction instead of letting the summarizer run,
  and it keeps no entries, so the pointer message is the only thing left in the new context.
- If anything throws, the handler returns nothing, so pi falls back to normal compaction and you
  never end up with an empty context.

## Caveats

- Picking up where it left off costs pi a few tool calls to read the transcript. In return, it
  gets the real history instead of a lossy summary.
- pi only calls the hook when it has something to summarize. If the projected context is under
  `keepRecentTokens`, or the session is not persisted at all (`--no-session`), no compaction is
  attempted, so the pointer never appears. That is pi's behavior, not the extension's.
