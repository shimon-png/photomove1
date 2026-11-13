import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reelbot — videos from your Google Photos",
  description: "Chat with Reelbot to turn photos from your Google Photos into short videos.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
