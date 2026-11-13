import { z } from "zod";

/** A storyboard Claude produces; the browser renders it into a video. Shared by server and client. */
export const MOTIONS = ["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "none"] as const;
export const TRANSITIONS = ["crossfade", "fade_black", "cut"] as const;
export const ASPECTS = ["16:9", "9:16", "1:1"] as const;

/** Background music bundled in /public/music. The user picks one under the video. */
export const MUSIC_TRACKS = [
  { id: "electronic-warmth", title: "Electronic Warmth", src: "/music/electronic-warmth.m4a" },
  { id: "nostalgic-trumpet", title: "Nostalgic Trumpet with Band", src: "/music/nostalgic-trumpet.m4a" },
  { id: "family-portrait", title: "Electronic Family Portrait", src: "/music/family-portrait.m4a" },
] as const;
export const MUSIC_IDS = ["none", ...MUSIC_TRACKS.map((t) => t.id)] as [string, ...string[]];

export const SceneSchema = z.object({
  /** A photo (p…, g…) or video clip (v…). */
  media_id: z.string().min(1).max(10),
  duration_s: z.number().min(0.5).max(60),
  /** Ken Burns motion; ignored for video clips. */
  motion: z.enum(MOTIONS),
  caption: z.string().max(120).optional(),
  /** Video clips: where in the clip to start, in seconds. */
  clip_start_s: z.number().min(0).max(3600).optional(),
  /** Video clips: play the clip's own sound (music dips underneath). */
  clip_audio: z.boolean().optional(),
});

/** A voice note (a…) that plays starting at a scene; music dips while it plays. */
export const VoiceNoteSchema = z.object({
  media_id: z.string().min(1).max(10),
  at_scene: z.number().int().min(0).max(99),
  offset_s: z.number().min(0).max(60).optional(),
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
  voice_notes: z.array(VoiceNoteSchema).max(20).optional(),
  /** Chosen by the user in the UI, not by Claude. */
  music: z.enum(MUSIC_IDS).optional(),
});

/**
 * A reaction texted back by someone the video was shared with. Rendered as a
 * quote card inserted after scene `after_scene` (-1 = before the first scene).
 */
export type ReactionCard = { after_scene: number; text: string; author: string };

export type VideoPlan = z.infer<typeof VideoPlanSchema> & { reactions?: ReactionCard[] };

export const MEDIA_KINDS = ["photo", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Media metadata Claude sees. Ids are short and stable for a selection:
 * p1… device photos, v1… device videos, a1… voice notes, g1… Google photos.
 */
export const MediaMetaSchema = z.object({
  id: z.string().max(10),
  kind: z.enum(MEDIA_KINDS),
  filename: z.string().max(200).optional(),
  createTime: z.string().max(40).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_s: z.number().min(0).max(36000).optional(),
});
export type MediaMeta = z.infer<typeof MediaMetaSchema>;

/**
 * Media as the browser holds it. Google photos carry a baseUrl (served via the
 * image proxy); device files carry the File itself and never leave the device
 * except as small previews Claude asks to see — unless the user shares the
 * video, which uploads them and gives each a public `url`.
 */
export type MediaRef = MediaMeta & { baseUrl?: string; file?: File; url?: string; thumb?: string };

/** What the conversation is working with; sent on every chat request. */
export const SelectionSchema = z.object({
  device: z.array(MediaMetaSchema).max(200),
  google: z.object({ pickerSessionId: z.string().min(1).max(200) }).optional(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export type ClientToolCall = { id: string; name: string; input: unknown };

/** NDJSON events streamed from /api/chat to the browser. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "choose_photos"; maxItems: number }
  | { type: "video_plan"; plan: VideoPlan }
  | { type: "share_request"; recipientName: string; phone: string }
  | { type: "messages"; messages: unknown[] }
  /** Tools the browser must run (media previews); `results` are the server-run ones from the same turn. */
  | { type: "client_tools"; calls: ClientToolCall[]; results: unknown[] }
  | { type: "error"; message: string }
  | { type: "done" };
