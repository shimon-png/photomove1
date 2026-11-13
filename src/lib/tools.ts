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
    name: "ask_for_media",
    description:
      "Show the user a chooser to add photos, videos and voice notes: from their phone's camera roll / computer files, a voice recorder, or Google Photos (photos only). Call this when nothing is selected yet or the user wants to add or change media. Then tell the user what to add and end your turn; you will get a message once they are done.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        max_items: { type: "integer", description: "Suggested maximum number of items (1-100). Default 30." },
      },
      required: ["max_items"],
      additionalProperties: false,
    },
  },
  {
    name: "list_selected_media",
    description:
      "List everything the user selected: short id, kind (photo, video, audio = voice note), filename, capture time, dimensions and duration. Call this before planning a video.",
    strict: true,
    eager_input_streaming: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "view_media",
    description:
      "Look at previews of selected photos and videos (a video shows as a strip of frames from its start, middle and end) so you can order them, choose clip ranges, write captions and pick motion. Voice notes can't be previewed. At most 12 ids per call and 36 previews per conversation; prefer a representative subset when there are many.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        media_ids: { type: "array", items: { type: "string" }, description: "Short ids such as p1, v2, g3" },
      },
      required: ["media_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "create_video",
    description:
      "Render a video from the selected media. Provide the full storyboard. Scenes are photos (0.5-15 s, with Ken Burns motion) or video clips (choose clip_start_s and duration_s within the clip's length; set clip_audio to keep the clip's own sound). Voice notes play starting at a scene; make the scenes that follow long enough to cover the note. Background music is chosen by the user under the video, not here. The video is rendered in the user's browser, where they can preview and download it. Call again with a revised storyboard to make changes.",
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
              media_id: { type: "string", description: "A photo or video id" },
              duration_s: { type: "number" },
              motion: { type: "string", enum: [...MOTIONS], description: "Photos only; use none for videos" },
              caption: { type: "string", description: "Optional caption, max 120 chars" },
              clip_start_s: { type: "number", description: "Videos only: start offset within the clip" },
              clip_audio: { type: "boolean", description: "Videos only: keep the clip's own sound" },
            },
            required: ["media_id", "duration_s", "motion"],
            additionalProperties: false,
          },
        },
        voice_notes: {
          type: "array",
          description: "Voice notes (audio ids) to play over the video",
          items: {
            type: "object",
            properties: {
              media_id: { type: "string" },
              at_scene: { type: "integer", description: "Index of the scene where the voice note starts" },
              offset_s: { type: "number", description: "Optional delay after that scene starts" },
            },
            required: ["media_id", "at_scene"],
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
export const AskForMediaInput = z.object({ max_items: z.number().int().min(1).max(100) });
export const ListMediaInput = z.object({});
export const ViewMediaInput = z.object({ media_ids: z.array(z.string()).min(1).max(12) });

export const SYSTEM_PROMPT = `You are Reelbot, a friendly assistant that turns a user's photos, video clips and voice notes into short videos.

How you work:
- You can only see media the user explicitly adds: photos and videos from their device (camera roll), voice notes they record or pick, or photos through the Google Photos picker. You cannot browse or search their library. If nothing is selected, call ask_for_media.
- Once media is selected, list it, look at previews where it helps, and propose a storyboard: order (usually chronological unless a story suggests otherwise), pacing, motion and captions.
- Video clips: pick the best moment with clip_start_s and keep clips short (usually 3-8 s) unless asked otherwise. Keep clip_audio on when the clip likely has meaningful sound (people talking, singing, a moment), off for scenery.
- Voice notes: you can't hear them; you only know their length and filename. Ask the user what a voice note is about if its placement matters, otherwise place it where it fits the story (often near the start or end). Make the scenes after its start add up to at least its length. Don't overlap voice notes with each other or with clips that keep their audio.
- Ask at most one or two quick questions when the request is genuinely ambiguous (mood, length, vertical vs landscape). Otherwise make sensible choices and render.
- Default to roughly 3 seconds per photo, crossfade transitions of 0.8 s, and 16:9, unless the user asks for something else. Vertical 9:16 suits Reels, Shorts and TikTok.
- Captions are optional; keep them short, and never invent names, places or facts you cannot see in the media or metadata.
- Background music: the user picks one of three tracks under the video (one is chosen at random). If they ask about music, tell them to use the music picker there.
- After create_video, briefly describe what you made and invite edits ("slower", "add captions", "make it vertical"). Revisions mean calling create_video again with the full updated storyboard.
- The user can share a finished video by text message: ask for the person's name and phone number, then call share_video. The user confirms in a form before anything is sent, so say that the form is ready rather than that it was sent. People who receive it can text back reactions, which get added to the video as quote cards.
- Keep replies short and conversational.`;
