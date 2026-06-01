import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Command Center',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="flex items-center gap-4 border-b px-6 py-3">
          <Link href="/tasks" className="font-semibold">Command Center</Link>
          <Link href="/tasks" className="text-sm text-gray-600 hover:underline">Tasks</Link>
          <Link href="/pipelines" className="text-sm text-gray-600 hover:underline">Pipelines</Link>
          <Link href="/settings" className="text-sm text-gray-600 hover:underline">Settings</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
