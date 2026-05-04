export const OAUTH_PROVIDERS = {
  youtube: {
    name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: 'openid profile email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
    getProfile: async (accessToken: string) => {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch YouTube profile');
      const data = await res.json();
      return {
        id: data.sub,
        name: data.name,
        username: data.email, // Google doesn't have usernames, email is standard
        image: data.picture,
      };
    },
  },
  linkedin: {
    name: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo',
    scopes: 'openid profile w_member_social email',
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
    getProfile: async (accessToken: string) => {
      const res = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch LinkedIn profile');
      const data = await res.json();
      return {
        id: data.sub,
        name: data.name,
        username: data.email,
        image: data.picture,
      };
    },
  },
  tiktok: {
    name: 'TikTok',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    profileUrl: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username',
    scopes: 'user.info.basic video.upload',
    clientIdEnv: 'TIKTOK_CLIENT_KEY', // Note: TikTok uses client_key
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
    getProfile: async (accessToken: string) => {
      const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch TikTok profile');
      const json = await res.json();
      const data = json.data?.user;
      return {
        id: data?.open_id || data?.union_id,
        name: data?.display_name,
        username: data?.username,
        image: data?.avatar_url,
      };
    },
  },
};

export type OAuthPlatform = keyof typeof OAUTH_PROVIDERS;

export function getRedirectUri(platform: OAuthPlatform, reqUrl: string) {
  const url = new URL(reqUrl);
  // Reconstruct base URL
  const baseUrl = `${url.protocol}//${url.host}`;
  return `${baseUrl}/api/auth/${platform}/callback`;
}
