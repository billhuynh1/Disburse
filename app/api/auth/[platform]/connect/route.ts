import { NextRequest, NextResponse } from 'next/server';
import { OAUTH_PROVIDERS, OAuthPlatform, getRedirectUri } from '@/lib/auth/oauth';
import { getUser } from '@/lib/db/queries';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { platform } = await params;

    if (!(platform in OAUTH_PROVIDERS)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 });
    }

    const providerId = platform as OAuthPlatform;
    const provider = OAUTH_PROVIDERS[providerId];
    
    const clientId = process.env[provider.clientIdEnv];
    
    if (!clientId) {
      return NextResponse.json(
        { error: `${provider.name} OAuth is not configured. Missing Client ID.` },
        { status: 500 }
      );
    }

    const redirectUri = getRedirectUri(providerId, request.url);
    
    // Generate state to prevent CSRF
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    const url = new URL(provider.authUrl);
    
    if (providerId === 'tiktok') {
      url.searchParams.set('client_key', clientId);
    } else {
      url.searchParams.set('client_id', clientId);
    }
    
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes);
    url.searchParams.set('state', state);

    if (providerId === 'youtube') {
      url.searchParams.set('access_type', 'offline'); // To get refresh token
      url.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
    }

    const response = NextResponse.redirect(url.toString());
    
    // Store state in cookie to verify in callback
    response.cookies.set(`oauth_state_${providerId}`, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Error initiating OAuth:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
