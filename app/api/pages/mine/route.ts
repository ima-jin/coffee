import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { db } from '@/db';
import { authenticate } from '@/lib/auth/authenticate';
import { jsonResponse, errorResponse } from '@/lib/utils';

const log = createLogger('coffee');

/**
 * GET /api/pages/mine - Get current user's coffee page
 *
 * The reference adoption of the scoped app token (#1974): callers present
 * `Authorization: Bearer <token>` minted for this app's own host.
 */
export async function GET(request: NextRequest) {
  // Require authentication
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, did),
    });

    if (!page) {
      return errorResponse('No coffee page found', 404);
    }

    return jsonResponse(page);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch user coffee page');
    return errorResponse('Failed to fetch coffee page', 500);
  }
}
