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
