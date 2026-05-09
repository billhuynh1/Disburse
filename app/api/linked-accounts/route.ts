import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/drizzle';
import { linkedAccounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUser } from '@/lib/db/queries';
import {
  getLinkedAccountPublishBlockedReason,
  isSupportedSocialAccountPlatform,
} from '@/lib/disburse/linked-account-service';

export async function GET(request: NextRequest) {
  try {
    const user = await getUser();
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accounts = await db
      .select({
        id: linkedAccounts.id,
        platform: linkedAccounts.platform,
        platformAccountId: linkedAccounts.platformAccountId,
        platformAccountName: linkedAccounts.platformAccountName,
        platformAccountUsername: linkedAccounts.platformAccountUsername,
        platformAccountImage: linkedAccounts.platformAccountImage,
        accessToken: linkedAccounts.accessToken,
        expiresAt: linkedAccounts.expiresAt,
        createdAt: linkedAccounts.createdAt,
      })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.userId, user.id));

    return NextResponse.json({
      accounts: accounts
        .filter((account) => isSupportedSocialAccountPlatform(account.platform))
        .map((account) => {
          const publishBlockedReason = getLinkedAccountPublishBlockedReason(
            account
          );

          return {
            id: account.id,
            platform: account.platform,
            platformAccountId: account.platformAccountId,
            platformAccountName: account.platformAccountName,
            platformAccountUsername: account.platformAccountUsername,
            platformAccountImage: account.platformAccountImage,
            expiresAt: account.expiresAt,
            createdAt: account.createdAt,
            publishable: publishBlockedReason === null,
            publishBlockedReason,
          };
        }),
    });
  } catch (error) {
    console.error('Error fetching linked accounts:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getUser();
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('id');

    if (!accountId) {
      return NextResponse.json({ error: 'Missing account ID' }, { status: 400 });
    }

    await db
      .delete(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.id, parseInt(accountId)),
          eq(linkedAccounts.userId, user.id)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting linked account:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
