import type { PickedMediaItem } from "./google";
import type { MediaRef } from "./plan";

/** Stable short ids (g1, g2, …) in the order Google returns picked items. Google videos are skipped. */
export function toGoogleMedia(items: PickedMediaItem[]): MediaRef[] {
  return items
    .filter((it) => it.type !== "VIDEO" && !(it.mediaFile.mimeType ?? "").startsWith("video/"))
    .map((it, i) => ({
      id: `g${i + 1}`,
      kind: "photo" as const,
      baseUrl: it.mediaFile.baseUrl,
      filename: it.mediaFile.filename,
      createTime: it.createTime,
      width: it.mediaFile.mediaFileMetadata?.width,
      height: it.mediaFile.mediaFileMetadata?.height,
    }));
}
