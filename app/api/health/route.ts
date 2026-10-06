import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'imajin-app-template',
    timestamp: new Date().toISOString(),
  });
}
