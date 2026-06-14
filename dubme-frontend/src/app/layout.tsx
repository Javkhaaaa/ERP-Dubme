import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  // cyrillic-ext carries the distinctive Mongolian letters Ө/ө/Ү/ү
  // (U+04E8/E9, U+04AE/AF); without it they fall back mid-word to a system font.
  subsets: ["latin", "cyrillic", "cyrillic-ext"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "dubme.mn — Хятад → Монгол видео dubbing",
  description:
    "AI-аар хятад видеог монгол хэл рүү автомат орчуулж дубляж хийнэ.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="mn" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
