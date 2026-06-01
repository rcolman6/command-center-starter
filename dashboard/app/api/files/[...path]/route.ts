import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const ALLOWED_ROOT = path.resolve(process.cwd(), '..'); // repo root; outputs live under workers/workspace
const MIME: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.diff': 'text/plain', '.patch': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const filePath = path.resolve(ALLOWED_ROOT, ...segments);
  if (!filePath.startsWith(ALLOWED_ROOT)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 }); // no traversal out
  }
  try {
    const data = await fs.readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    return new NextResponse(data, {
      headers: { 'Content-Type': type, 'Content-Disposition': `inline; filename="${path.basename(filePath)}"` },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
