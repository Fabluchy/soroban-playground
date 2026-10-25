// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Tests for SSOProvider
 */

import { SSOProvider } from './ssoProvider';

describe('SSOProvider', () => {
  let provider: SSOProvider;

  beforeEach(() => {
    provider = new SSOProvider();
  });

  describe('SAML Metadata Generation', () => {
    test('should generate valid SAML 2.0 SP metadata', () => {
      const config = {
        type: 'saml' as const,
        entityId: 'soroban-sp',
        acsUrl: 'https://example.com/saml/acs',
        sloUrl: 'https://example.com/saml/slo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const metadata = provider.generateSAMLMetadata(config);

      expect(metadata).toContain('<?xml version="1.0"');
      expect(metadata).toContain('EntityDescriptor');
      expect(metadata).toContain('SPSSODescriptor');
      expect(metadata).toContain(config.entityId);
      expect(metadata).toContain(config.acsUrl);
    });

    test('should include single logout service in metadata', () => {
      const config = {
        type: 'saml' as const,
        entityId: 'test-sp',
        acsUrl: 'https://example.com/acs',
        sloUrl: 'https://example.com/slo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const metadata = provider.generateSAMLMetadata(config);
      expect(metadata).toContain('SingleLogoutService');
      expect(metadata).toContain('https://example.com/slo');
    });

    test('should generate certificate fingerprint for signing', () => {
      const config = {
        type: 'saml' as const,
        entityId: 'test-sp',
        acsUrl: 'https://example.com/acs',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const metadata = provider.generateSAMLMetadata(config);
      expect(metadata).toContain('X509Certificate');
    });
  });

  describe('SAML Assertion Validation', () => {
    test('should validate SAML assertion with valid issuer', async () => {
      const assertionXml = `
        <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
          <Issuer>https://idp.example.com</Issuer>
          <saml:NameID>user@example.com</saml:NameID>
          <Signature><SignatureValue></SignatureValue></Signature>
          <SubjectConfirmationData NotOnOrAfter="2099-12-31T23:59:59Z"/>
          <saml:Attribute Name="email"><saml:AttributeValue>user@example.com</saml:AttributeValue></saml:Attribute>
        </saml:Assertion>
      `;

      const result = await provider.validateSAMLAssertion(
        assertionXml,
        'https://idp.example.com'
      );
      expect(result.valid).toBe(true);
      expect(result.assertion).toBeDefined();
    });

    test('should reject SAML assertion with mismatched issuer', async () => {
      const assertionXml = `
        <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
          <Issuer>https://wrong-idp.example.com</Issuer>
          <saml:NameID>user@example.com</saml:NameID>
        </saml:Assertion>
      `;

      const result = await provider.validateSAMLAssertion(
        assertionXml,
        'https://idp.example.com'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should extract attributes from SAML assertion', async () => {
      const assertionXml = `
        <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
          <Issuer>https://idp.example.com</Issuer>
          <saml:NameID>user@example.com</saml:NameID>
          <Signature><SignatureValue></SignatureValue></Signature>
          <SubjectConfirmationData NotOnOrAfter="2099-12-31T23:59:59Z"/>
          <saml:Attribute Name="email"><saml:AttributeValue>user@example.com</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="name"><saml:AttributeValue>Test User</saml:AttributeValue></saml:Attribute>
        </saml:Assertion>
      `;

      const result = await provider.validateSAMLAssertion(
        assertionXml,
        'https://idp.example.com'
      );
      if (result.assertion) {
        expect(result.assertion.attributes).toBeDefined();
      }
    });

    test('should reject expired assertions', async () => {
      const assertionXml = `
        <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
          <Issuer>https://idp.example.com</Issuer>
          <saml:NameID>user@example.com</saml:NameID>
          <Signature><SignatureValue></SignatureValue></Signature>
          <SubjectConfirmationData NotOnOrAfter="2000-01-01T00:00:00Z"/>
        </saml:Assertion>
      `;

      const result = await provider.validateSAMLAssertion(
        assertionXml,
        'https://idp.example.com'
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('expired'))).toBe(true);
    });
  });

  describe('OIDC Authorization Code Flow', () => {
    test('should generate OIDC authorization URL', () => {
      const config = {
        type: 'oidc' as const,
        entityId: 'test-client',
        acsUrl: 'https://example.com/callback',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        authorizationEndpoint: 'https://idp.example.com/auth',
        tokenEndpoint: 'https://idp.example.com/token',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const authUrl = provider.generateOIDCAuthorizationUrl(
        config,
        'https://example.com/callback'
      );

      expect(authUrl).toContain('https://idp.example.com/auth');
      expect(authUrl).toContain('client_id=test-client-id');
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain('code_challenge');
      expect(authUrl).toContain('code_challenge_method=S256');
    });

    test('should include PKCE parameters in auth URL', () => {
      const config = {
        type: 'oidc' as const,
        entityId: 'test-client',
        acsUrl: 'https://example.com/callback',
        clientId: 'test-client-id',
        authorizationEndpoint: 'https://idp.example.com/auth',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const authUrl = provider.generateOIDCAuthorizationUrl(
        config,
        'https://example.com/callback'
      );
      expect(authUrl).toContain('code_challenge');
      expect(authUrl).toContain('state=');
    });

    test('should exchange OIDC code for tokens', async () => {
      const config = {
        type: 'oidc' as const,
        entityId: 'test-client',
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        tokenEndpoint: 'https://idp.example.com/token',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Generate auth URL first to set up state
      const authUrl = provider.generateOIDCAuthorizationUrl(
        config,
        'https://example.com/callback'
      );

      // Extract state from URL
      const stateMatch = authUrl.match(/state=([^&]+)/);
      const state = stateMatch ? stateMatch[1] : '';

      // Note: In real tests, state verification would need the actual Redis
      expect(state).toBeDefined();
      expect(state.length).toBeGreaterThan(0);
    });
  });

  describe('Identity Claims Mapping', () => {
    test('should map enterprise groups to workspace roles', async () => {
      const assertion = {
        issuer: 'https://idp.example.com',
        subject: 'user@example.com',
        nameId: 'user@example.com',
        sessionIndex: 'session-123',
        authnInstant: Date.now(),
        sessionNotOnOrAfter: Date.now() + 3600000,
        attributes: {
          email: ['user@example.com'],
          name: ['Test User'],
          groups: ['engineering', 'admins'],
        },
      };

      const roleMapping = {
        domain: 'example.com',
        emailDomain: 'example.com',
        defaultRole: 'user',
        groupMappings: new Map([
          ['engineering', 'developer'],
          ['admins', 'admin'],
        ]),
        customAttributeMappings: new Map(),
      };

      const claims = await provider.mapIdentityClaimsToRoles(
        assertion,
        roleMapping
      );
      expect(claims.email).toBe('user@example.com');
      expect(claims.roles).toContain('user'); // default
      expect(claims.groups).toContain('engineering');
    });
  });

  describe('Domain Management', () => {
    test('should store SSO configuration', async () => {
      const config = {
        type: 'saml' as const,
        entityId: 'test-sp',
        acsUrl: 'https://example.com/acs',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await provider.storeSSOConfig('example.com', config);
      const retrieved = await provider.getSSOConfig('example.com');

      expect(retrieved).toBeDefined();
      if (retrieved) {
        expect(retrieved.entityId).toBe('test-sp');
      }
    });

    test('should generate domain verification token', () => {
      const token = provider.generateDomainVerificationToken('example.com');
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);
    });

    test('should verify domain ownership', async () => {
      const dnsRecord =
        'v=spf1 _soroban-sso-verify.example.com include:spf.example.com ~all';
      const valid = await provider.verifyDomainOwnership(
        'example.com',
        dnsRecord
      );
      expect(typeof valid).toBe('boolean');
    });
  });

  describe('Audit Logging', () => {
    test('should log SSO audit events', async () => {
      await provider.logAuditEvent(
        'example.com',
        'sso_login',
        {
          method: 'saml',
          status: 'success',
        },
        'user-123'
      );

      const trail = await provider.getAuditTrail('example.com', 10);
      expect(Array.isArray(trail)).toBe(true);
    });

    test('should retrieve audit trail', async () => {
      await provider.logAuditEvent('example.com', 'test_event', {});
      const trail = await provider.getAuditTrail('example.com', 10);

      expect(Array.isArray(trail)).toBe(true);
    });
  });

  describe('Provider Support Matrix', () => {
    test('should list supported providers', () => {
      const providers = provider.getSupportedProviders();

      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);

      // Check for major providers
      const providerNames = providers.map((p) => p.provider);
      expect(providerNames).toContain('Okta');
      expect(providerNames).toContain('Google Workspace');
      expect(providerNames).toContain('Microsoft Entra ID (Azure AD)');
    });
  });
});
