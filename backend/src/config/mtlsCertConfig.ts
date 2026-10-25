import * as fs from 'fs';
import * as https from 'https';
import { TLSSocket } from 'tls';

export interface MtlsConfigOptions {
  caCertPath: string;
  serverCertPath: string;
  serverKeyPath: string;
}

export class MtlsCertManager {
  private caCert: Buffer;
  private serverCert: Buffer;
  private serverKey: Buffer;
  private certPathOptions: MtlsConfigOptions;

  constructor(options: MtlsConfigOptions) {
    this.certPathOptions = options;
    this.loadCertificates();
  }

  /**
   * Load or reload certificates from disk (enables zero-downtime rotation)
   */
  public loadCertificates(): void {
    try {
      this.caCert = fs.readFileSync(this.certPathOptions.caCertPath);
      this.serverCert = fs.readFileSync(this.certPathOptions.serverCertPath);
      this.serverKey = fs.readFileSync(this.certPathOptions.serverKeyPath);
    } catch (err: any) {
      throw new Error(
        `[mTLS] Failed to load certificates from disk: ${err.message}`
      );
    }
  }

  /**
   * Create HTTPS server options enforcing Mutual TLS (mTLS)
   */
  public createServerOptions(): https.ServerOptions {
    return {
      ca: this.caCert,
      cert: this.serverCert,
      key: this.serverKey,
      requestCert: true,
      rejectUnauthorized: true, // Strictly reject unauthorized or missing client certs
      minVersion: 'TLSv1.3', // Enforce modern secure TLS version
    };
  }

  /**
   * Extract client microservice identity from Subject Alternative Name (SAN) or Common Name (CN)
   */
  public static extractClientIdentity(socket: TLSSocket): {
    serviceName: string;
    isValid: boolean;
  } {
    if (!socket.authorized) {
      return { serviceName: '', isValid: false };
    }

    const peerCert = socket.getPeerCertificate();
    if (!peerCert || !peerCert.subject) {
      return { serviceName: '', isValid: false };
    }

    // Extract Subject Alternative Name (URI or DNS) or fallback to CN
    const san = peerCert.subjectaltname;
    if (san) {
      const match = san.match(/(?:URI:|DNS:)([^\s,]+)/);
      if (match && match[1]) {
        return { serviceName: match[1], isValid: true };
      }
    }

    if (peerCert.subject.CN) {
      return { serviceName: peerCert.subject.CN, isValid: true };
    }

    return { serviceName: '', isValid: false };
  }
}
