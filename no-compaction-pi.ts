import type {
  BoundaryResult,
  BoundaryState,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
  SessionEntry,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HANDOFF_TYPE = "no-compaction";
const RESET_TOOL = "context_reset";
const LOG_TOOL = "session_log";
const STATUS_KEY = "no-compaction";
const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_CHARS = 250;
const MAX_LIMIT = 200;
const MAX_CHARS = 2000;

// Kept in the extension closure so a reload mid-session still knows where the log is.
let transcriptPath = "";
// What the model wants the next context to know: written by the tool, consumed at the next boundary.
let pendingHandoff: string | undefined;
// Reconstructed from the active branch, so /tree, /resume and /reload stay honest.
let resets = 0;

function recordPath(ctx: ExtensionContext): void {
  const path = ctx.sessionManager.getSessionFile();
  if (path) transcriptPath = path;
}

function isNoCompaction(entry: SessionEntry): boolean {
  return entry.type === "compaction" && Boolean((entry.details as { noCompaction?: boolean })?.noCompaction);
}

function countResets(ctx: ExtensionContext): number {
  return ctx.sessionManager.getBranch().filter(isNoCompaction).length;
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}...` : flat;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text") parts.push(String(b.text ?? ""));
    else if (b.type === "toolCall") parts.push(`${b.name}(${JSON.stringify(b.arguments ?? {})})`);
    else if (b.type === "image") parts.push("<image>");
  }
  return parts.join(" ");
}

function describeEntry(entry: SessionEntry, maxChars: number): string {
  switch (entry.type) {
    case "message":
      const message = entry.message as { role: string; content?: unknown };
      return `${message.role}: ${clip(contentToText(message.content), maxChars) || "(empty)"}`;
    case "compaction":
      return `pointer${isNoCompaction(entry) ? " (no-compaction)" : ""}: ${clip(entry.summary, maxChars)}`;
    case "branch_summary":
      return `branch summary of the abandoned branch from ${entry.fromId}: ${clip(entry.summary, maxChars)}`;
    case "custom_message":
      return `custom message (${entry.customType}): ${clip(contentToText(entry.content), maxChars)}`;
    case "context_edit":
      return `edit on ${entry.targetId}: ${entry.replacement === null ? "that entry is omitted from context" : clip(contentToText(entry.replacement), maxChars)}`;
    default:
      // label, usage, model_change, thinking_level_change, custom, session_info: state, not context.
      return entry.type;
  }
}

export default function (pi: ExtensionAPI) {
  // Line numbers in the log file: the header is line 1, entries follow in append order.
  function lineNumbers(ctx: ExtensionContext): Map<string, number> {
    const lines = new Map<string, number>();
    ctx.sessionManager.getEntries().forEach((entry, index) => lines.set(entry.id, index + 2));
    return lines;
  }

  function budget(ctx: ExtensionContext) {
    const settings = pi.getSettings().compaction ?? {};
    const model = ctx.model;
    const override = model ? settings.modelOverrides?.[`${model.provider}/${model.id}`] : undefined;
    const reserve = override?.reserveTokens ?? settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    const keep = override?.keepRecentTokens ?? settings.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    const window = model?.contextWindow ?? 0;
    const measured = ctx.getContextUsage()?.tokens ?? null;
    let tokens = measured ?? 0;
    if (measured === null) {
      for (const message of ctx.sessionManager.buildSessionProjection().messages) tokens += estimateTokens(message);
    }
    return { tokens, measured, window, reserve, keep, firesAt: Math.max(0, window - reserve), enabled: settings.enabled !== false };
  }

  function usageText(ctx: ExtensionContext): string {
    const b = budget(ctx);
    if (b.window <= 0) return "No context window is known for the current model, so there is nothing to report.";
    const percent = ((b.tokens / b.window) * 100).toFixed(1);
    const lines = [
      `Your context now: ${num(b.tokens)} tokens, ${percent}% of a ${num(b.window)} token window` +
        (b.measured === null ? " (character estimate, no measured usage yet)." : "."),
      b.enabled
        ? `The next reset fires above ${num(b.firesAt)} tokens, so about ${num(Math.max(0, b.firesAt - b.tokens))} tokens are left.`
        : "Compaction is off, so no reset will fire on its own.",
      `A reset here keeps nothing, so a fresh context gets the whole window back. pi only attempts one once the context is above ${num(b.keep)} tokens, so below that only this tool can reset.`,
      `Do not guess usage from the size of the session log: the log spans every previous reset, while your context is only what is in front of you. Ask ${RESET_TOOL} for the real number.`,
    ];
    return lines.join("\n");
  }

  // The pointer message is all the new context holds, so it has to carry everything.
  function pointerMessage(ctx: ExtensionContext, handoff?: string): string {
    const path = transcriptPath || ctx.sessionManager.getSessionFile() || "(no persisted log)";
    const lines = lineNumbers(ctx);
    const leaf = ctx.sessionManager.getLeafEntry();
    const b = budget(ctx);
    const out = [
      `No-compaction reset #${resets + 1}. Nothing was summarized: your context holds only this message` +
        (handoff ? " and the handoff note that follows it." : "."),
      `The history is the session log, an ordinary file you can read: ${path}`,
      "",
      "The log is JSONL, one entry per line, and entries form a TREE linked by `id`/`parentId`. A file can",
      "hold several trees, and line order is append order, not conversation order, so entries of different",
      "branches are interleaved. Your conversation is the path from a root to the active leaf, and this",
      `reset was made on the branch ending at entry ${leaf?.id ?? "?"} (line ${leaf ? lines.get(leaf.id) : "?"}).`,
      "Walk `parentId` from there back to its root and read only that path; entries of the other branches",
      "are not your conversation, and a branch_summary entry on the path names the branch that was left.",
      "",
      `Read the log through the ${LOG_TOOL} tool rather than raw cat/tail: action "tree" lists every root`,
      `and marks the active branch, action "entries" prints a branch oldest-first with line numbers.`,
      "Lines hold whole tool results, and anything you read counts against your own context, so read a",
      "few lines at a time, cap each to a few hundred characters, and start from the end of the branch",
      "for where work stopped and the first user message for the goal.",
      "",
      `Do not estimate how much context you have used from the size of the log. At this reset your context`,
      `was about ${num(b.tokens)} tokens, and it is now nearly empty, so you have roughly ${num(b.firesAt)} tokens`,
      `of room before the next reset (${num(b.window)} window minus the ${num(b.reserve)} reserved for output). Ask`,
      `${RESET_TOOL} (action "status") for the actual number instead of guessing, and when you are genuinely`,
      `close to the limit and at a clean break point, call ${RESET_TOOL} (action "reset") with a handoff note:`,
      "work then continues here in a fresh context, so do not wrap up early and do not hand control back",
      "to the user unless the work is truly finished.",
    ];
    return out.join("\n");
  }

  // Boundary handler: the tool asked for a reset, so carry the handoff into the new context
  // and make sure the run continues instead of returning control to the user.
  function boundaryReset(event: BoundaryState, ctx: ExtensionContext): BoundaryResult | undefined {
    if (!pendingHandoff) return undefined;
    const handoff = pendingHandoff;
    pendingHandoff = undefined;

    const b = budget(ctx);
    const leaf = ctx.sessionManager.getLeafEntry();
    const drafts: SessionBoundaryDraft[] = [...event.entries];

    // A retain-none compaction records its own id, so only what is appended after it survives.
    drafts.push({
      type: "compaction",
      summary: pointerMessage(ctx, handoff),
      firstKeptEntryId: null,
      details: {
        noCompaction: true,
        reset: resets + 1,
        fromEntry: leaf?.id,
        tokensAtReset: b.tokens,
        handoff,
      },
    });
    drafts.push({
      type: "custom_message",
      customType: HANDOFF_TYPE,
      content: `Handoff from the context that ended at line ${lineNumbers(ctx).get(leaf?.id ?? "") ?? "?"} (entry ${leaf?.id ?? "?"}): ${handoff}`,
      display: true,
      details: { handoff: true },
    });

    return { entries: drafts, continue: event.continue || event.context.canContinue };
  }

  function showStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const b = budget(ctx);
    if (b.window <= 0) return;
    ctx.ui.setStatus(STATUS_KEY, `nc ${b.measured === null ? "~" : ""}${((b.tokens / b.window) * 100).toFixed(0)}% · ${num(b.tokens)}/${num(b.window)} · resets: ${resets}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    recordPath(ctx);
    resets = countResets(ctx);
    showStatus(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    recordPath(ctx);
    resets = countResets(ctx);
    showStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    recordPath(ctx);
    resets = countResets(ctx);
    showStatus(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    pendingHandoff = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // Nothing to precompute: the replacement is free.
  pi.on("session_before_compact", async (event, ctx) => {
    // A compaction that keeps nothing: the summary slot holds the pointer message, so the
    // nullish firstKeptEntryId makes pi record the entry's own id and nothing else survives.
    const path = transcriptPath || ctx.sessionManager.getSessionFile();
    if (!path) {
      ctx.ui.notify("no-compaction: transcript path unknown, using normal compaction", "warning");
      return;
    }

    try {
      return {
        compaction: {
          summary: pointerMessage(ctx),
          firstKeptEntryId: null as unknown as string,
          tokensBefore: event.preparation.tokensBefore,
          details: { noCompaction: true, reset: resets + 1, fromEntry: ctx.sessionManager.getLeafId() },
        },
      };
    } catch {
      // Never end up with an empty context: fall back to normal compaction.
      return;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    showStatus(ctx);
    return boundaryReset(event, ctx);
  });
  // Fallback for a reset requested at a boundary that cannot continue on its own.
  pi.on("agent_before_settle", async (event, ctx) => {
    return boundaryReset(event, ctx);
  });

  pi.registerTool({
    name: RESET_TOOL,
    label: "Context reset",
    description:
      "Your own context budget, and your own choice of when to reset it. action \"status\" reports the " +
      "real usage in place of guessing from the size of the session log. action \"reset\" clears your " +
      "context at the end of this turn and then continues work in the fresh context: the pointer to the " +
      "log and your handoff note are all that survives, so call it at a clean break point and write a " +
      "handoff the next context can continue from alone.",
    promptSnippet: "Report real context usage, or reset the context at a break point and keep working",
    promptGuidelines: [
      `Do not estimate context usage from the size of the session log; the log spans all previous resets. Call ${RESET_TOOL} (action "status") for the actual number instead of guessing.`,
      `Do not wrap up work early to reach a context boundary. When ${RESET_TOOL} reports you are genuinely close to the limit and you are at a clean break point, call it with action "reset" and a handoff note; the run continues after the reset, so stop only when the work is really done.`,
      `Call ${RESET_TOOL} with action "reset" as the only tool call of a turn: the tool results of that turn do not survive the reset.`,
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "reset"], description: "\"status\" reports usage; \"reset\" clears the context at the end of this turn." }),
      handoff: Type.Optional(Type.String({ description: "For action \"reset\": what the next context must know - the goal, what is done, what comes next, the files involved. Besides the pointer it is the only thing that survives, so it has to stand on its own." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      recordPath(ctx);
      const report = usageText(ctx);
      const path = transcriptPath;
      if (!path) {
        return {
          content: [{ type: "text", text: `No session log: this session is not persisted, so the no-compaction workflow cannot run and normal summarization applies. ${report}` }],
          details: { action: params.action, persisted: false },
        };
      }
      if (params.action === "status") {
        return { content: [{ type: "text", text: `${report}\nLog: ${path}` }], details: { action: "status", tokens: budget(ctx).tokens } };
      }

      const handoff = (params.handoff ?? "").trim();
      if (!handoff) {
        return {
          content: [{ type: "text", text: `Reset needs a handoff: the next context will hold the pointer to ${path} plus nothing else but what you write here. ${report}` }],
          details: { action: "reset", handoff: "" },
          isError: true,
        };
      }

      pendingHandoff = handoff;
      const b = budget(ctx);
      return {
        content: [
          {
            type: "text",
            text:
              `Reset scheduled for the end of this turn: the new context will hold the pointer to ${path} and your handoff, and the run is asked to continue. Everything before the reset, including this result, is gone from context, so the handoff has to stand on its own.\n\n` +
              `Handoff as it will be carried:\n${handoff}\n\n${report}\n` +
              `That is ${b.tokens <= b.firesAt * 0.25 ? "not close to the limit: it is a clean restart rather than a rescue, and you have plenty of room" : "close to the limit, so resetting here is the right call"}.\n` +
              "Do not wrap up for the user now; work on.",
          },
        ],
        details: { action: "reset", handoff, tokens: b.tokens, firesAt: b.firesAt },
      };
    },
  });

  pi.registerTool({
    name: LOG_TOOL,
    label: "Session log",
    description:
      "Read the session log as the tree it actually is. The log is JSONL, one entry per line, with " +
      "entries linked by id/parentId; one file can hold several trees, and line order is append order, " +
      "not conversation order, so branches are interleaved. action \"tree\" lists the roots and marks the " +
      "active branch; action \"entries\" prints a branch oldest-first with the file line numbers to read " +
      "from. Output is capped: default 25 entries at 250 characters each, max 200 entries at 2000.",
    promptSnippet: "Read the session log tree: roots, active branch, entries with file line numbers",
    promptGuidelines: [
      `Use ${LOG_TOOL} instead of reading the session log top-to-bottom: it follows the active branch, which is the conversation to continue, and reports the line numbers to read.`,
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ["tree", "entries"], description: "\"tree\" shows roots and the active branch; \"entries\" prints one branch." }),
      from: Type.Optional(Type.String({ description: "Entry id to read from (default: the active leaf)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum entries to print, newest end of the branch (default 25, max 200)" })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters per entry (default 250, max 2000)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      recordPath(ctx);
      const path = transcriptPath || ctx.sessionManager.getSessionFile();
      if (!path) return { content: [{ type: "text", text: "No session log: this session is not persisted." }], details: {}, isError: true };

      const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
      const maxChars = Math.min(Math.max(20, params.maxChars ?? DEFAULT_MAX_CHARS), MAX_CHARS);
      const lines = lineNumbers(ctx);
      const entries = ctx.sessionManager.getEntries();
      const leaf = ctx.sessionManager.getLeafEntry();
      const branch = ctx.sessionManager.getBranch(params.from);
      if (branch.length === 0) {
        return { content: [{ type: "text", text: `Entry ${params.from} is not in this session log.` }], details: {}, isError: true };
      }

      if (params.action === "tree") {
        const tree = ctx.sessionManager.getTree();
        const activeRoot = branch[0];
        const size = (node: SessionTreeNode): number => 1 + node.children.reduce((total, child) => total + size(child), 0);
        const listed = branch.slice(-limit);
        const out = [
          `Session log ${path}: ${entries.length} entries in ${tree.length} tree${tree.length === 1 ? "" : "s"}.`,
          "",
          "Roots (file order):",
        ];
        for (const root of tree) {
          out.push(`- line ${lines.get(root.entry.id)} entry ${root.entry.id}: ${size(root)} entr${size(root) === 1 ? "y" : "ies"}${root.entry.id === activeRoot.id ? "  <- the branch to continue" : ""}`);
        }
        out.push("", `Active branch: root ${activeRoot.id} to leaf ${leaf?.id ?? "?"}, ${branch.length} entries, newest ${listed.length} listed.`);
        out.push(`Path: ${listed.map((entry) => `line ${lines.get(entry.id)} ${entry.id}`).join(" ")}`);
        if (branch.length > listed.length) out.push(`(${branch.length - listed.length} earlier entries on this branch not listed)`);
        return { content: [{ type: "text", text: out.join("\n") }], details: { action: "tree", trees: tree.length, branchLength: branch.length } };
      }

      const shown = branch.slice(-limit);
      const out = [
        `Branch of ${path} from root ${branch[0].id} to ${params.from ? `entry ${params.from}` : "the active leaf"}, ${branch.length} entries, showing the newest ${shown.length}:`,
        "",
      ];
      for (const entry of shown) out.push(`line ${lines.get(entry.id)} | ${entry.id} <- ${entry.parentId ?? "(root)"} | ${describeEntry(entry, maxChars)}`);
      if (branch.length > shown.length) out.push(`(${branch.length - shown.length} earlier entries on this branch not shown)`);
      return { content: [{ type: "text", text: out.join("\n") }], details: { action: "entries", branchLength: branch.length, shown: shown.length } };
    },
  });
}
