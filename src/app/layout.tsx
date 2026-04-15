import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export const metadata: Metadata = {
  title: "AI Persona | Abhinav Jha",
  description:
    "Talk to my AI representative — ask about my background, skills, projects, or book an interview.",
  openGraph: {
    title: "AI Persona | Abhinav Jha",
    description: "Voice & chat AI persona — RAG-grounded over real resume and GitHub. Book an interview directly.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased light"
      style={{ colorScheme: "light" }}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
