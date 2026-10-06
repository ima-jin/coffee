import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { getNodeSelf } from '@ima-jin/config';
import { buildFairManifest } from '@ima-jin/fair';
import { db, coffeePages } from '@/db';
import { authenticate } from '@/lib/auth/authenticate';
import { jsonResponse, errorResponse, isValidHandle, generateId } from '@/lib/utils';

const log = createLogger('coffee');

/**
 * POST /api/pages - Create a new tip page
 */
export async function POST(request: NextRequest) {
  // Require authentication (scoped app token, or session cookie fallback)
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const body = await request.json();
    const {
      handle,
      title,
      bio,
      avatar,
      avatarAssetId,
      theme,
      paymentMethods,
      presets,
      allowCustomAmount,
      allowMessages,
      thankYouContent,
    } = body;

    // Validate required fields
    if (!handle) {
      return errorResponse('handle is required');
    }

    if (!title) {
      return errorResponse('title is required');
    }

    if (!isValidHandle(handle)) {
      return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric and underscores only');
    }

    // Validate payment methods
    if (!paymentMethods || (!paymentMethods.stripe && !paymentMethods.solana)) {
      return errorResponse('At least one payment method (stripe or solana) is required');
    }

    // Check if page already exists for this DID
    const existingDid = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.did, did),
    });

    if (existingDid) {
      return errorResponse('You already have a coffee page', 409);
    }

    // Check handle uniqueness
    const existingHandle = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (existingHandle) {
      return errorResponse('Handle is already taken', 409);
    }

    // Node config comes from the kernel registry's public route (REGISTRY_SERVICE_URL).
    // App tokens carry no act-as scope, so there is never a forest scope fee here.
    const nodeSelf = await getNodeSelf();
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: did,
      contentType: 'coffee_page',
      scopeDid: null,
      scopeFeeBps: null,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
    });

    // Create page
    const [page] = await db
      .insert(coffeePages)
      .values({
        id: generateId('page'),
        did,
        handle,
        title,
        bio: bio || null,
        avatar: avatar || null,
        avatarAssetId: avatarAssetId || null,
        theme: theme || {},
        paymentMethods,
        presets: presets || [100, 500, 1000],
        thankYouContent: thankYouContent || null,
        allowCustomAmount: allowCustomAmount !== false,
        allowMessages: allowMessages !== false,
        isPublic: true,
        fairManifest,
      })
      .returning();

    return jsonResponse(page, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create coffee page');
    return errorResponse('Failed to create coffee page', 500);
  }
}
