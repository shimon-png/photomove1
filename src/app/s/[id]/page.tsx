import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharePlayer } from "@/components/SharePlayer";
import { getPublicShare } from "@/lib/shares";

export async function generateMetadata({ params }: PageProps<"/s/[id]">): Promise<Metadata> {
  const { id } = await params;
  const share = await getPublicShare(id).catch(() => null);
  if (!share) return { title: "Video not found" };
  return {
    title: `${share.plan.title} — from ${share.senderName}`,
    description: `${share.senderName} made you a video. Reply to the text to add your reaction.`,
    robots: { index: false },
  };
}

export default async function SharePage({ params }: PageProps<"/s/[id]">) {
  const { id } = await params;
  const share = await getPublicShare(id);
  if (!share) notFound();
  return <SharePlayer initial={share} />;
}
