import { z } from "zod";

/** A storyboard Claude produces; the browser renders it into a video. Shared by server and client. */
export const MOTIONS = ["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "none"] as const;
export const TRANSITIONS = ["crossfade", "fade_black", "cut"] as const;
export const ASPECTS = ["16:9", "9:16", "1:1"] as const;

export const SceneSchema = z.object({
  photo_id: z.string().min(1),
  duration_s: z.number().min(0.5).max(15),
  motion: z.enum(MOTIONS),
  caption: z.string().max(120).optional(),
});

export const VideoPlanSchema = z.object({
  title: z.string().min(1).max(80),
  aspect: z.enum(ASPECTS),
  transition: z.enum(TRANSITIONS),
  transition_s: z.number().min(0).max(3),
  intro_text: z.string().max(80).optional(),
  outro_text: z.string().max(80).optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  scenes: z.array(SceneSchema).min(1).max(100),
});

export type VideoPlan = z.infer<typeof VideoPlanSchema>;

/** Photo metadata Claude sees. Ids are short (p1, p2, …) and stable for a selection. */
export const PhotoMetaSchema = z.object({
  id: z.string().max(10),
  filename: z.string().max(200).optional(),
  createTime: z.string().max(40).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type PhotoMeta = z.infer<typeof PhotoMetaSchema>;

/**
 * A photo as the browser holds it. Google photos carry a baseUrl (served via
 * the image proxy); camera-roll photos carry the File itself and never leave
 * the device except as small previews Claude asks to see.
 */
export type PhotoRef = PhotoMeta & { baseUrl?: string; file?: File };

/** Which photos the conversation is working with; sent on every chat request. */
export const SelectionSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("none") }),
  z.object({ source: z.literal("google"), pickerSessionId: z.string().min(1).max(200) }),
  z.object({ source: z.literal("device"), photos: z.array(PhotoMetaSchema).max(200) }),
]);
export type Selection = z.infer<typeof SelectionSchema>;

export type ClientToolCall = { id: string; name: string; input: unknown };

/** NDJSON events streamed from /api/chat to the browser. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "choose_photos"; maxItems: number }
  | { type: "video_plan"; plan: VideoPlan }
  | { type: "messages"; messages: unknown[] }
  /** Tools the browser must run (e.g. previews of camera-roll photos); `results` are the server-run ones from the same turn. */
  | { type: "client_tools"; calls: ClientToolCall[]; results: unknown[] }
  | { type: "error"; message: string }
  | { type: "done" };
