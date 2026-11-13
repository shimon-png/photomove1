import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ASPECTS, MOTIONS, TRANSITIONS } from "./plan";

/**
 * Client-defined tools. Streaming + eager_input_streaming means the API does
 * not validate inputs for us, so every input is re-checked with Zod before it
 * runs (see route.ts). Numeric bounds live in Zod rather than the JSON schema.
 */
export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "ask_for_photos",
    description:
      "Show the user a photo chooser: their phone's camera roll / computer files, or Google Photos. Call this when no photos are selected yet or the user wants different ones. Then tell the user to choose photos and end your turn; you will get a message once they are done.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        max_items: { type: "integer", description: "Suggested maximum number of photos (1-100). Default 30." },
      },
      required: ["max_items"],
      additionalProperties: false,
    },
  },
  {
    name: "list_selected_photos",
    description:
      "List the photos the user picked: short id, filename, capture time and dimensions. Call this before planning a video.",
    strict: true,
    eager_input_streaming: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "view_photos",
    description:
      "Look at small previews of selected photos so you can order them, write captions and pick motion. At most 12 per call and 36 per conversation; prefer viewing a representative subset when there are many.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        photo_ids: { type: "array", items: { type: "string" }, description: "Short ids such as p1, p2" },
      },
      required: ["photo_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "create_video",
    description:
      "Render a video from the selected photos. Provide the full storyboard: scene order, per-scene duration (0.5-15 s), Ken Burns motion and an optional short caption. The video is rendered in the user's browser, where they can preview and download it. Call again with a revised storyboard to make changes.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the video (max 80 chars)" },
        aspect: { type: "string", enum: [...ASPECTS], description: "16:9 landscape, 9:16 vertical (Reels/Shorts/TikTok), 1:1 square" },
        transition: { type: "string", enum: [...TRANSITIONS] },
        transition_s: { type: "number", description: "Transition length in seconds (0-3)" },
        intro_text: { type: "string", description: "Optional title card text shown first" },
        outro_text: { type: "string", description: "Optional closing card text" },
        accent_color: { type: "string", description: "Optional #RRGGBB color for title cards" },
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              photo_id: { type: "string" },
              duration_s: { type: "number" },
              motion: { type: "string", enum: [...MOTIONS] },
              caption: { type: "string", description: "Optional caption, max 120 chars" },
            },
            required: ["photo_id", "duration_s", "motion"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "aspect", "transition", "transition_s", "scenes"],
      additionalProperties: false,
    },
  },
  {
    name: "share_video",
    description:
      "Prepare to text the current video to someone. The app shows the user a pre-filled form and nothing is sent until they confirm it. Only call this after create_video, and only once you know the recipient's name and phone number (ask for them if the user hasn't said). The recipient can reply by text; their reaction is added to the video as a quote card.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        recipient_name: { type: "string", description: "First name of the person, as the user calls them (e.g. Mom, Dana)" },
        phone: { type: "string", description: "Their phone number exactly as the user gave it, including country code if given" },
      },
      required: ["recipient_name", "phone"],
      additionalProperties: false,
    },
  },
];

export const ShareVideoInput = z.object({
  recipient_name: z.string().trim().min(1).max(40),
  phone: z.string().trim().min(4).max(30),
});

export const AskForPhotosInput = z.object({ max_items: z.number().int().min(1).max(100) });
export const ListPhotosInput = z.object({});
export const ViewPhotosInput = z.object({ photo_ids: z.array(z.string()).min(1).max(12) });

export const SYSTEM_PROMPT = `You are Reelbot, a friendly assistant that turns a user's Google Photos into short videos.

How you work:
- You can only see photos the user explicitly chooses, either from their device (camera roll) or through the Google Photos picker; you cannot browse or search their library. If nothing is selected, call ask_for_photos.
- Once photos are selected, list them, look at previews where it helps, and propose a storyboard: order (usually chronological unless a story suggests otherwise), pacing, motion and captions.
- Ask at most one or two quick questions when the request is genuinely ambiguous (mood, length, vertical vs landscape). Otherwise make sensible choices and render.
- Default to roughly 3 seconds per photo, crossfade transitions of 0.8 s, and 16:9, unless the user asks for something else. Vertical 9:16 suits Reels, Shorts and TikTok.
- Captions are optional; keep them short, and never invent names, places or facts you cannot see in the photo or metadata.
- After create_video, briefly describe what you made and invite edits ("slower", "add captions", "make it vertical"). Revisions mean calling create_video again with the full updated storyboard.
- The user can share a finished video by text message: ask for the person's name and phone number, then call share_video. The user confirms in a form before anything is sent, so say that the form is ready rather than that it was sent. People who receive it can text back reactions, which get added to the video as quote cards.
- Keep replies short and conversational.`;
