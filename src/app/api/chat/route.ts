import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchPhoto, getAccessToken, GoogleApiError, listPickedItems } from "@/lib/google";
import { toPhotoRefs } from "@/lib/photos";
import {
  SelectionSchema,
  VideoPlanSchema,
  type ChatEvent,
  type ClientToolCall,
  type PhotoRef,
  type Selection,
} from "@/lib/plan";
import { AskForPhotosInput, ListPhotosInput, ShareVideoInput, SYSTEM_PROMPT, tools, ViewPhotosInput } from "@/lib/tools";
import { sharingEnabled } from "@/lib/config";

export const maxDuration = 300;

const client = new Anthropic();
const MODEL = "claude-opus-5-5";
const MAX_TURNS = 10;
const MAX_VIEWED_PER_CONVERSATION = 36;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

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
  photos?: PhotoRef[];
};

/** Result of a tool the server ran, or a marker that the browser must run it. */
type ToolOutcome =
  | { kind: "done"; content: string | Anthropic.Beta.BetaToolResultBlockParam["content"]; isError?: boolean }
  | { kind: "client" };

async function getPhotos(ctx: ToolContext): Promise<PhotoRef[]> {
  if (ctx.photos) return ctx.photos;
  const sel = ctx.selection;
  if (sel.source === "device") ctx.photos = sel.photos;
  else if (sel.source === "google") {
    if (!ctx.googleToken) throw new GoogleApiError(401, "Google Photos is not connected anymore. Ask the user to reconnect or pick photos from their device.");
    ctx.photos = toPhotoRefs(await listPickedItems(ctx.googleToken, sel.pickerSessionId));
  } else ctx.photos = [];
  return ctx.photos;
}

async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "ask_for_photos": {
      const parsed = AskForPhotosInput.safeParse(input);
      if (!parsed.success) return invalid(input);
      ctx.emit({ type: "choose_photos", maxItems: parsed.data.max_items });
      return { kind: "done", content: "A photo chooser is now showing. Ask the user to pick photos; you'll be told when they finish." };
    }
    case "list_selected_photos": {
      if (!ListPhotosInput.safeParse(input).success) return invalid(input);
      const photos = await getPhotos(ctx);
      if (photos.length === 0) return { kind: "done", content: "No photos are selected yet. Call ask_for_photos." };
      const rows = photos.map(({ id, filename, createTime, width, height }) => ({ id, filename, createTime, width, height }));
      return { kind: "done", content: JSON.stringify({ source: ctx.selection.source, count: rows.length, photos: rows }) };
    }
    case "view_photos": {
      const parsed = ViewPhotosInput.safeParse(input);
      if (!parsed.success) return invalid(input);
      if (ctx.viewedSoFar >= MAX_VIEWED_PER_CONVERSATION) {
        return { kind: "done", content: "Preview limit reached for this conversation; plan from metadata.", isError: true };
      }
      // Camera-roll photos only exist in the browser, which builds the previews itself.
      if (ctx.selection.source === "device") return { kind: "client" };
      return { kind: "done", content: await googlePreviews(parsed.data.photo_ids, ctx) };
    }
    case "create_video": {
      const parsed = VideoPlanSchema.safeParse(input);
      if (!parsed.success) return { kind: "done", content: `Invalid storyboard: ${parsed.error.message}`, isError: true };
      const known = new Set((await getPhotos(ctx)).map((p) => p.id));
      const unknown = parsed.data.scenes.map((s) => s.photo_id).filter((id) => !known.has(id));
      if (unknown.length) return { kind: "done", content: `Unknown photo ids: ${unknown.join(", ")}`, isError: true };
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

async function googlePreviews(ids: string[], ctx: ToolContext) {
  const photos = await getPhotos(ctx);
  const wanted = ids.slice(0, MAX_VIEWED_PER_CONVERSATION - ctx.viewedSoFar);
  const blocks: Anthropic.Beta.BetaToolResultBlockParam["content"] = [];
  for (const id of wanted) {
    const photo = photos.find((p) => p.id === id);
    if (!photo?.baseUrl) {
      blocks.push({ type: "text", text: `${id}: unknown id` });
      continue;
    }
    const { bytes, contentType } = await fetchPhoto(ctx.googleToken!, photo.baseUrl, 384);
    const mediaType = IMAGE_TYPES.find((t) => contentType.startsWith(t)) ?? "image/jpeg";
    blocks.push({ type: "text", text: `${id}${photo.createTime ? ` (taken ${photo.createTime})` : ""}:` });
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") } });
    ctx.viewedSoFar++;
  }
  return blocks;
}

function invalid(input: unknown): ToolOutcome {
  return { kind: "done", content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }), isError: true };
}

/** Counts images already returned by view_photos earlier in the conversation. */
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
  const googleToken = selection.source === "google" ? await getAccessToken() : null;
  if (selection.source === "google" && !googleToken) {
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
    case "ask_for_photos":
      return "Asking for photos…";
    case "list_selected_photos":
      return "Reading your selected photos…";
    case "view_photos":
      return "Looking at your photos…";
    case "create_video":
      return "Building the storyboard…";
    case "share_video":
      return "Preparing to share…";
    default:
      return "Working…";
  }
}
