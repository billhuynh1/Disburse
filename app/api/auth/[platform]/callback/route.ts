import { NextRequest, NextResponse } from 'next/server';
import { OAUTH_PROVIDERS, OAuthPlatform, getRedirectUri } from '@/lib/auth/oauth';
import { getUser } from '@/lib/db/queries';
import { db } from '@/lib/db/drizzle';
import { linkedAccounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.redirect(new URL('/sign-in', request.url));
    }

    const { platform } = await params;
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      console.error('OAuth error from provider:', error);
      return NextResponse.redirect(new URL('/dashboard?error=oauth_rejected', request.url));
    }

    if (!code || !state) {
      return NextResponse.redirect(new URL('/dashboard?error=missing_code_or_state', request.url));
    }

    if (!(platform in OAUTH_PROVIDERS)) {
      return NextResponse.redirect(new URL('/dashboard?error=invalid_platform', request.url));
    }

    const providerId = platform as OAuthPlatform;
    const provider = OAUTH_PROVIDERS[providerId];
    
    // Verify state
    const cookieState = request.cookies.get(`oauth_state_${providerId}`)?.value;
    if (state !== cookieState) {
      return NextResponse.redirect(new URL('/dashboard?error=invalid_state', request.url));
    }

    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    const redirectUri = getRedirectUri(providerId, request.url);

    if (!clientId || !clientSecret) {
      console.error(`Missing OAuth credentials for ${providerId}`);
      return NextResponse.redirect(new URL('/dashboard?error=missing_credentials', request.url));
    }

    // Exchange code for token
    const tokenBody = new URLSearchParams();
    if (providerId === 'tiktok') {
      tokenBody.append('client_key', clientId);
      tokenBody.append('client_secret', clientSecret);
    } else {
      tokenBody.append('client_id', clientId);
      tokenBody.append('client_secret', clientSecret);
    }
    
    tokenBody.append('code', code);
    tokenBody.append('grant_type', 'authorization_code');
    tokenBody.append('redirect_uri', redirectUri);

    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error('Token exchange failed:', errorText);
      return NextResponse.redirect(new URL('/dashboard?error=token_exchange_failed', request.url));
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token; // Might be undefined depending on provider
    const expiresIn = tokenData.expires_in; // in seconds

    // Calculate expiration date
    let expiresAt: Date | null = null;
    if (expiresIn) {
      expiresAt = new Date(Date.now() + expiresIn * 1000);
    }

    // Fetch user profile from platform
    const profile = await provider.getProfile(accessToken);

    // Check if account is already linked
    const existingAccount = await db
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.userId, user.id),
          eq(linkedAccounts.platform, providerId),
          eq(linkedAccounts.platformAccountId, profile.id)
        )
      )
      .limit(1);

    if (existingAccount.length > 0) {
      // Update existing
      await db
        .update(linkedAccounts)
        .set({
          accessToken,
          ...(refreshToken ? { refreshToken } : {}), // Only update if provided
          expiresAt,
          platformAccountName: profile.name,
          platformAccountUsername: profile.username,
          platformAccountImage: profile.image,
          updatedAt: new Date(),
        })
        .where(eq(linkedAccounts.id, existingAccount[0].id));
    } else {
      // Insert new
      await db.insert(linkedAccounts).values({
        userId: user.id,
        platform: providerId,
        platformAccountId: profile.id,
        platformAccountName: profile.name,
        platformAccountUsername: profile.username,
        platformAccountImage: profile.image,
        accessToken,
        refreshToken,
        expiresAt,
      });
    }

    // Redirect to dashboard with success flag
    const response = NextResponse.redirect(new URL('/dashboard?connected=true', request.url));
    
    // Clear the state cookie
    response.cookies.delete(`oauth_state_${providerId}`);

    return response;

  } catch (error) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(new URL('/dashboard?error=internal_error', request.url));
  }
}
