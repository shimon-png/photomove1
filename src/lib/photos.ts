import type { PickedMediaItem } from "./google";
import type { PhotoRef } from "./plan";

/** Stable short ids (p1, p2, …) in the order Google returns picked items. Videos are skipped. */
export function toPhotoRefs(items: PickedMediaItem[]): PhotoRef[] {
  return items
    .filter((it) => it.type !== "VIDEO" && !(it.mediaFile.mimeType ?? "").startsWith("video/"))
    .map((it, i) => ({
      id: `p${i + 1}`,
      baseUrl: it.mediaFile.baseUrl,
      filename: it.mediaFile.filename,
      createTime: it.createTime,
      width: it.mediaFile.mediaFileMetadata?.width,
      height: it.mediaFile.mediaFileMetadata?.height,
    }));
}
