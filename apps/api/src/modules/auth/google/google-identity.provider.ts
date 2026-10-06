import { Injectable, Logger } from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { env } from '../../../config/env'

/** The verified claims this app acts on. Everything else in the token is ignored. */
export interface GoogleProfile {
  /** Google's stable, never-reassigned identifier for the account. */
  sub: string
  /** Only ever present when the provider reports the address as verified. */
  email: string | null
  name: string | null
  picture: string | null
}

export interface GoogleAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * Thin wrapper over google-auth-library.
 *
 * Isolating it behind an interface is what makes the callback flow testable without
 * a network: the service depends on this shape, not on the library, so tests
 * substitute a fake. The library is used rather than hand-rolled JWT verification
 * because checking an ID token means fetching and rotating Google's JWKS and
 * validating the signature, audience, issuer and expiry — all easy to get subtly
 * wrong, and wrong in a way that authenticates nobody or everybody.
 */
@Injectable()
export class GoogleIdentityProvider {
  private readonly logger = new Logger(GoogleIdentityProvider.name)
  private client: OAuth2Client | null = null

  get enabled(): boolean {
    return env.google.enabled
  }

  /**
   * HMAC key for the signed `state`. Exposed here rather than read from env in the
   * service so there is a single seam for the whole Google configuration: tests
   * substitute this provider and get a known secret for free.
   */
  get stateSecret(): string {
    if (!env.google.stateSecret) throw new Error('Google sign-in is not configured')
    return env.google.stateSecret
  }

  /**
   * Verified addresses allowed to hold role='admin'.
   *
   * Lives on the provider rather than being read straight from env so tests can
   * swap the provider and control promotion without touching process.env.
   */
  get adminEmails(): string[] {
    return env.google.adminEmails
  }

  private config(): GoogleAuthConfig {
    if (!env.google.enabled) throw new Error('Google sign-in is not configured')
    return {
      clientId: env.google.clientId as string,
      clientSecret: env.google.clientSecret as string,
      redirectUri: env.google.redirectUri as string,
    }
  }

  private oauth(): OAuth2Client {
    // Built once: the client caches the discovery document and JWKS, and rebuilding
    // it per request would throw that away on every login. The client secret is
    // supplied to the constructor rather than per call — that is where the library
    // reads it from when exchanging a code. redirect_uri is passed explicitly on
    // each call instead, because the property is not writable.
    if (!this.client) {
      const { clientId, clientSecret } = this.config()
      this.client = new OAuth2Client(clientId, clientSecret)
    }
    return this.client
  }

  /**
   * A PKCE verifier and its S256 challenge.
   *
   * Included even though this is a confidential client with a secret: PKCE costs
   * nothing here and means an intercepted authorization code is useless on its own.
   */
  newPkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  authorizeUrl(state: string, codeChallenge: string): string {
    const { clientId, redirectUri } = this.config()
    return this.oauth().generateAuthUrl({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', 'profile'],
      // Forces the account chooser. Without it a visitor who is already signed in
      // to Google silently lands on whichever account that is, which is a reliable
      // way to save a favorite search to the wrong person's account.
      prompt: 'select_account',
      include_granted_scopes: false,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      state,
    })
  }

  /**
   * Exchanges the authorization code and verifies the resulting ID token.
   *
   * Throws on any failure — bad code, reused code, wrong audience, expired token,
   * bad signature. The caller turns that into a rejected login, never into an
   * account.
   */
  async authenticate(code: string, codeVerifier: string): Promise<GoogleProfile> {
    const { clientId, redirectUri } = this.config()
    const { tokens } = await this.oauth().getToken({
      code,
      codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    })
    if (!tokens.id_token) throw new Error('Google returned no id_token')

    const ticket = await this.oauth().verifyIdToken({
      idToken: tokens.id_token,
      // Binds the token to this deployment. Without it a token minted for any other
      // client that uses Google sign-in would verify fine.
      audience: clientId,
    })
    const payload = ticket.getPayload()
    if (!payload?.sub) throw new Error('Google id_token carried no sub')

    // Google only sets this on addresses it has verified. An unverified address
    // means anyone who can add it to their Google account could claim the identity.
    if (payload.email_verified !== true) throw new Error('Google email is not verified')

    this.logger.log(`Google identity verified for sub=${payload.sub}`)

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    }
  }
}
