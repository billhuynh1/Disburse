import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import { SWRConfig } from 'swr';

export const metadata: Metadata = {
  title: 'Disburse',
  description:
    'Disburse helps creators turn one long-form recording into a multi-channel content pack.'
};

export const viewport: Viewport = {
  maximumScale: 1
};

const manrope = Manrope({ subsets: ['latin'] });

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark bg-background text-foreground ${manrope.className}`}
    >
      <body className="min-h-[100dvh] bg-background text-foreground">
        <SWRConfig>{children}</SWRConfig>
      </body>
    </html>
  );
}
