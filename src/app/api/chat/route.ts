import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { sharingEnabled } from "@/lib/config";
import { getAccessToken, GoogleApiError, listPickedItems } from "@/lib/google";
import { toGoogleMedia } from "@/lib/photos";
import {
  SelectionSchema,
  VideoPlanSchema,
  type ChatEvent,
  type ClientToolCall,
  type MediaMeta,
  type Selection,
  type VideoPlan,
} from "@/lib/plan";
import { AskForMediaInput, ListMediaInput, ShareVideoInput, SYSTEM_PROMPT, tools, ViewMediaInput } from "@/lib/tools";

export const maxDuration = 300;

const client = new Anthropic();
const MODEL = "claude-opus-5-5";
const MAX_TURNS = 10;
const MAX_VIEWED_PER_CONVERSATION = 36;

const Body = z.object({
  // Conversation history is held by the browser and replayed unchanged each request.
  messages: z.array(z.any()).min(1).max(400),
  selection: SelectionSchema,
});

type ToolContext = {
  selection: Selection;
  googleToken: string | null;
  viewedSoFar: number;
  emit: (e: ChatEvent) => void;
  media?: MediaMeta[];
};

/** Result of a tool the server ran, or a marker that the browser must run it. */
type ToolOutcome =
  | { kind: "done"; content: string | Anthropic.Beta.BetaToolResultBlockParam["content"]; isError?: boolean }
  | { kind: "client" };

async function getMedia(ctx: ToolContext): Promise<MediaMeta[]> {
  if (ctx.media) return ctx.media;
  const media: MediaMeta[] = [...ctx.selection.device];
  if (ctx.selection.google) {
    if (!ctx.googleToken) throw new GoogleApiError(401, "Google Photos is not connected anymore. Ask the user to reconnect or add photos from their device.");
    const google = toGoogleMedia(await listPickedItems(ctx.googleToken, ctx.selection.google.pickerSessionId));
    media.push(...google.map(({ id, kind, filename, createTime, width, height }) => ({ id, kind, filename, createTime, width, height })));
  }
  ctx.media = media;
  return media;
}

/** Checks a storyboard against the selected media; returns a problem description or null. */
function checkPlan(plan: VideoPlan, media: MediaMeta[]): string | null {
  const byId = new Map(media.map((m) => [m.id, m]));
  const problems: string[] = [];
  plan.scenes.forEach((s, i) => {
    const m = byId.get(s.media_id);
    if (!m) return problems.push(`scene ${i}: unknown media id ${s.media_id}`);
    if (m.kind === "audio") return problems.push(`scene ${i}: ${s.media_id} is a voice note; put it in voice_notes instead`);
    if (m.kind === "photo" && s.duration_s > 15) problems.push(`scene ${i}: photos can show for at most 15 s`);
    if (m.kind === "video" && m.duration_s !== undefined) {
      const start = s.clip_start_s ?? 0;
      if (start >= m.duration_s) problems.push(`scene ${i}: clip_start_s ${start} is past the end of ${s.media_id} (${m.duration_s.toFixed(1)} s)`);
      else if (start + s.duration_s > m.duration_s + 0.25) {
        problems.push(`scene ${i}: ${s.media_id} is only ${m.duration_s.toFixed(1)} s long; clip_start_s + duration_s must fit`);
      }
    }
  });
  (plan.voice_notes ?? []).forEach((v, i) => {
    const m = byId.get(v.media_id);
    if (!m || m.kind !== "audio") problems.push(`voice_notes[${i}]: ${v.media_id} is not a voice note`);
    if (v.at_scene >= plan.scenes.length) problems.push(`voice_notes[${i}]: at_scene ${v.at_scene} doesn't exist`);
  });
  return problems.length ? problems.join("; ") : null;
}

async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "ask_for_media": {
      const parsed = AskForMediaInput.safeParse(input);
      if (!parsed.success) return invalid(input);
      ctx.emit({ type: "choose_photos", maxItems: parsed.data.max_items });
      return { kind: "done", content: "A media chooser is now showing. Ask the user to add photos, videos or voice notes; you'll be told when they finish." };
    }
    case "list_selected_media": {
      if (!ListMediaInput.safeParse(input).success) return invalid(input);
      const media = await getMedia(ctx);
      if (media.length === 0) return { kind: "done", content: "Nothing is selected yet. Call ask_for_media." };
      return { kind: "done", content: JSON.stringify({ count: media.length, media }) };
    }
    case "view_media": {
      if (!ViewMediaInput.safeParse(input).success) return invalid(input);
      if (ctx.viewedSoFar >= MAX_VIEWED_PER_CONVERSATION) {
        return { kind: "done", content: "Preview limit reached for this conversation; plan from metadata.", isError: true };
      }
      // Media lives in the browser (device files) or behind its image proxy (Google), so it builds the previews.
      return { kind: "client" };
    }
    case "create_video": {
      const parsed = VideoPlanSchema.omit({ music: true }).safeParse(input);
      if (!parsed.success) return { kind: "done", content: `Invalid storyboard: ${parsed.error.message}`, isError: true };
      const problem = checkPlan(parsed.data, await getMedia(ctx));
      if (problem) return { kind: "done", content: `Please fix the storyboard: ${problem}`, isError: true };
      ctx.emit({ type: "video_plan", plan: parsed.data });
      const total = parsed.data.scenes.reduce((s, x) => s + x.duration_s, 0);
      return { kind: "done", content: `Rendering started in the user's browser: ${parsed.data.scenes.length} scenes, about ${Math.round(total)} s.` };
    }
    case "share_video": {
      const parsed = ShareVideoInput.safeParse(input);
      if (!parsed.success) return invalid(input);
      if (!sharingEnabled()) {
        return { kind: "done", content: "Sharing by text isn't set up on this app yet. Suggest downloading the video and sending it instead.", isError: true };
      }
      ctx.emit({ type: "share_request", recipientName: parsed.data.recipient_name, phone: parsed.data.phone });
      return { kind: "done", content: "A pre-filled share form is now showing under the video. The user must review it and tap Send; nothing has been sent yet." };
    }
    default:
      return { kind: "done", content: `Unknown tool ${name}`, isError: true };
  }
}

function invalid(input: unknown): ToolOutcome {
  return { kind: "done", content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }), isError: true };
}

/** Counts images already returned by view_media earlier in the conversation. */
function countViewed(messages: Anthropic.Beta.BetaMessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        n += block.content.filter((c) => c.type === "image").length;
      }
    }
  }
  return n;
}

export async function POST(req: Request) {
  const parsedBody = Body.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const { selection } = parsedBody.data;

  // Refresh Google tokens before streaming starts (cookies can't be set mid-stream).
  const googleToken = selection.google ? await getAccessToken() : null;
  if (selection.google && !googleToken) {
    return Response.json({ error: "Not connected to Google Photos" }, { status: 401 });
  }

  const history = parsedBody.data.messages as Anthropic.Beta.BetaMessageParam[];
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const ctx: ToolContext = { selection, googleToken, viewedSoFar: countViewed(history), emit };
      const messages = [...history];
      const added: Anthropic.Beta.BetaMessageParam[] = [];
      const push = (m: Anthropic.Beta.BetaMessageParam) => {
        messages.push(m);
        added.push(m);
      };
      let jsonRetries = 0;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const s = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 64000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "medium" },
            cache_control: { type: "ephemeral" },
            system: SYSTEM_PROMPT,
            tools,
            messages,
          });
          s.on("text", (delta) => emit({ type: "text", text: delta }));

          let message: Anthropic.Beta.BetaMessage;
          try {
            message = await s.finalMessage();
            jsonRetries = 0;
          } catch (err) {
            // Only an unparseable tool input is retried; API errors propagate.
            if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
            continue;
          }

          if (message.stop_reason === "refusal") {
            // Discard the partial turn; the user can rephrase.
            emit({ type: "error", message: "Claude declined this request. Try rephrasing it." });
            break;
          }

          push({ role: "assistant", content: message.content });

          const toolUses = message.content.filter(
            (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
          );
          if (message.stop_reason === "pause_turn") continue;
          if (toolUses.length === 0) break;
          if (message.stop_reason === "max_tokens") throw new Error("Response was cut off; please try again.");

          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          const clientCalls: ClientToolCall[] = [];
          for (const tu of toolUses) {
            emit({ type: "status", text: statusLabel(tu.name) });
            try {
              const out = await runTool(tu.name, tu.input, ctx);
              if (out.kind === "client") clientCalls.push({ id: tu.id, name: tu.name, input: tu.input });
              else results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, is_error: out.isError });
            } catch (err) {
              const msg = err instanceof GoogleApiError ? err.message : "Tool failed";
              results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
            }
          }

          if (clientCalls.length) {
            // Hand off: the browser runs these, then sends every result of this turn back in one user message.
            emit({ type: "client_tools", calls: clientCalls, results });
            break;
          }
          push({ role: "user", content: results });
        }
      } catch (err) {
        const message =
          err instanceof Anthropic.RateLimitError
            ? "Claude is rate limited right now; please retry shortly."
            : err instanceof Anthropic.APIError
              ? `Claude API error (${err.status ?? "network"})`
              : err instanceof Error
                ? err.message
                : "Something went wrong";
        emit({ type: "error", message });
      } finally {
        // Return the new turns so the browser can append them verbatim (thinking blocks included).
        emit({ type: "messages", messages: added });
        emit({ type: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function statusLabel(tool: string) {
  switch (tool) {
    case "ask_for_media":
      return "Asking for photos and videos…";
    case "list_selected_media":
      return "Reading your selection…";
    case "view_media":
      return "Looking at your photos and videos…";
    case "create_video":
      return "Building the storyboard…";
    case "share_video":
      return "Preparing to share…";
    default:
      return "Working…";
  }
}
