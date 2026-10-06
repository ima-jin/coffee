import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ImajinAuthStatus } from '@/components/ImajinAuthStatus';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Coffee',
  description: 'Coffee — tip pages, a third-party app on Imajin.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="flex items-center justify-between border-b border-gray-800/50 bg-gray-950/90 px-4 py-2 backdrop-blur">
            <span className="text-sm font-semibold text-white">Coffee</span>
            <ImajinAuthStatus />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
