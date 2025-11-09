import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { kv } from '@vercel/kv';

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.ROOT_URL}/api/auth/google/callback`
);

export function getGoogleAuthUrl() {
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.send'
  ];

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state: 'some-random-state-string', 
  });
}

export async function handleGoogleCallback(code) {
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const userEmail = data.email;

    if (!userEmail) {
      throw new Error("Não foi possível obter o e-mail do usuário do Google.");
    }
    
    if (tokens.refresh_token) {
      await kv.set('google_tokens', {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
        userEmail: userEmail 
      });
      console.log("Refresh Token e E-mail armazenados com sucesso no Vercel KV."); 
    } else {
      const existingTokens = await kv.get('google_tokens');
      await kv.set('google_tokens', {
        ...existingTokens,
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date,
        userEmail: userEmail
      });
      console.log("Access Token e E-mail atualizados no Vercel KV.");
    }
    
    return tokens;

  } catch (error) {
    console.error("Error exchanging code for tokens:", error.message);
    throw new Error("Failed to get tokens from Google.");
  }
}

export async function getAuthenticatedClient() {
  const tokens = await kv.get('google_tokens');
  
  if (!tokens || !tokens.refresh_token || !tokens.userEmail) {
    console.warn("Nenhum refresh token ou e-mail encontrado no KV store.");
    throw new Error("User is not authenticated. No refresh token or email found.");
  }

  client.setCredentials(tokens);

  if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
    console.log("Access Token expired. Refreshing...");
    try {
      const { credentials } = await client.refreshAccessToken();
      
      await kv.set('google_tokens', {
        ...tokens,
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date,
      });
      client.setCredentials(credentials);
      console.log("Tokens refreshed and stored.");

    } catch (refreshError) {
      console.error("Error refreshing access token:", refreshError.message);
      await kv.del('google_tokens');
      throw new Error("Failed to refresh token. Please log in again.");
    }
  }

  return { client, userEmail: tokens.userEmail };
}