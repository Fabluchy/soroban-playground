// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * User Session Security Engine with Device Fingerprinting
 * Detects anomalous login patterns and triggers step-up authentication
 * Issue: #1779
 *
 * Performance targets:
 * - < 3ms evaluation
 * - Zero false flags for standard users
 * - Session revocation via Redis
 */

import crypto from 'crypto';
import redisService from '../redisService.js';

interface DeviceFingerprint {
  hash: string;
  userAgent: string;
  acceptLanguage: string;
  acceptEncoding: string;
  timestamp: number;
}

interface GeoLocation {
  latitude: number;
  longitude: number;
  country: string;
  city: string;
  timestamp: number;
}

interface ThreatIntelligence {
  isVpn: boolean;
  isProxy: boolean;
  isTor: boolean;
  threatScore: number;
}

interface AnomalyScore {
  total: number;
  deviceFingerprint: number;
  geographicalVelocity: number;
  threatIntel: number;
  timeAnomalies: number;
  browserAnomalies: number;
}

interface SessionSecurityContext {
  userId: string;
  sessionId: string;
  deviceFingerprint: DeviceFingerprint;
  geoLocation: GeoLocation;
  threatIntel: ThreatIntelligence;
  anomalyScore: AnomalyScore;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresStepUp: boolean;
  auditTrail: AuditLogEntry[];
}

interface AuditLogEntry {
  timestamp: number;
  event: string;
  riskScore: number;
  details: Record<string, unknown>;
}

const ANOMALY_THRESHOLD = 70;
const IMPOSSIBLE_TRAVEL_THRESHOLD = 800; // km/h
const DEVICE_FINGERPRINT_TTL = 7 * 24 * 60 * 60; // 7 days
const SESSION_REVOCATION_TTL = 24 * 60 * 60; // 24 hours

// Mock threat intel database (in production, use MaxMind, IP2Location, etc.)
const TOR_EXIT_NODES = new Set<string>();
const KNOWN_VPN_RANGES = new Map<string, string>();
const KNOWN_PROXIES = new Map<string, string>();

export class AnomalyDetector {
  /**
   * Compute device fingerprint hash from request headers
   */
  computeDeviceFingerprint(headers: Record<string, string>): DeviceFingerprint {
    const components = [
      headers['user-agent'] || '',
      headers['accept-language'] || '',
      headers['accept-encoding'] || '',
      headers['accept'] || '',
      headers['sec-ch-ua'] || '',
    ];

    const hash = crypto
      .createHash('sha256')
      .update(components.join('|'))
      .digest('hex');

    return {
      hash,
      userAgent: headers['user-agent'] || '',
      acceptLanguage: headers['accept-language'] || '',
      acceptEncoding: headers['accept-encoding'] || '',
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate geographical velocity (km/h) between two locations
   */
  private calculateVelocity(
    prevLoc: GeoLocation,
    currLoc: GeoLocation
  ): number {
    const R = 6371; // Earth radius in km
    const lat1 = (prevLoc.latitude * Math.PI) / 180;
    const lat2 = (currLoc.latitude * Math.PI) / 180;
    const deltaLat = ((currLoc.latitude - prevLoc.latitude) * Math.PI) / 180;
    const deltaLon = ((currLoc.longitude - prevLoc.longitude) * Math.PI) / 180;

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(deltaLon / 2) *
        Math.sin(deltaLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    const timeDeltaHours =
      (currLoc.timestamp - prevLoc.timestamp) / (1000 * 3600);
    return timeDeltaHours > 0 ? distance / timeDeltaHours : 0;
  }

  /**
   * Check IP against threat intelligence databases
   */
  async checkThreatIntel(ipAddress: string): Promise<ThreatIntelligence> {
    // Mock threat intel check (in production, use real services)
    const isTor = TOR_EXIT_NODES.has(ipAddress);
    const isVpn = KNOWN_VPN_RANGES.has(ipAddress);
    const isProxy = KNOWN_PROXIES.has(ipAddress);

    return {
      isVpn,
      isProxy,
      isTor,
      threatScore: isTor ? 100 : isVpn || isProxy ? 50 : 0,
    };
  }

  /**
   * Evaluate anomaly score for a session
   */
  async evaluateAnomalies(
    context: Partial<SessionSecurityContext>
  ): Promise<number> {
    const scores: Partial<AnomalyScore> = {
      deviceFingerprint: 0,
      geographicalVelocity: 0,
      threatIntel: 0,
      timeAnomalies: 0,
      browserAnomalies: 0,
    };

    // Device fingerprint check
    if (context.userId && context.deviceFingerprint) {
      const prevFp = await this.getStoredDeviceFingerprint(context.userId);
      if (prevFp && prevFp.hash !== context.deviceFingerprint.hash) {
        scores.deviceFingerprint = 25; // New device
      }
    }

    // Geographical velocity check
    if (context.geoLocation) {
      const prevLoc = await this.getStoredLocation(context.userId!);
      if (prevLoc) {
        const velocity = this.calculateVelocity(prevLoc, context.geoLocation);
        if (velocity > IMPOSSIBLE_TRAVEL_THRESHOLD) {
          scores.geographicalVelocity = 50; // Impossible travel
        } else if (velocity > 200) {
          scores.geographicalVelocity = 15; // Suspicious travel
        }
      }
    }

    // Threat intel check
    if (context.threatIntel) {
      scores.threatIntel = context.threatIntel.threatScore;
    }

    // Time anomalies (early morning, unusual hours)
    const hour = new Date().getHours();
    if (hour >= 2 && hour <= 5) {
      scores.timeAnomalies = 10;
    }

    // Browser anomalies (spoofed user agent, etc.)
    if (context.deviceFingerprint?.userAgent.includes('Bot')) {
      scores.browserAnomalies = 20;
    }

    const total = Object.values(scores).reduce(
      (sum, val) => sum + (val || 0),
      0
    );
    return Math.min(total, 100);
  }

  /**
   * Evaluate full security context for a session
   */
  async evaluateSession(
    userId: string,
    sessionId: string,
    headers: Record<string, string>,
    ipAddress: string,
    geoLocation?: GeoLocation
  ): Promise<SessionSecurityContext> {
    const startTime = Date.now();
    const deviceFingerprint = this.computeDeviceFingerprint(headers);
    const threatIntel = await this.checkThreatIntel(ipAddress);

    const context: Partial<SessionSecurityContext> = {
      userId,
      sessionId,
      deviceFingerprint,
      geoLocation:
        geoLocation ||
        ({
          latitude: 0,
          longitude: 0,
          country: 'unknown',
          city: 'unknown',
          timestamp: Date.now(),
        } as GeoLocation),
      threatIntel,
    };

    const anomalyScore = (await this.evaluateAnomalies(context)) as number;
    const riskLevel = this.getRiskLevel(anomalyScore);
    const requiresStepUp = anomalyScore > ANOMALY_THRESHOLD;

    const securityContext: SessionSecurityContext = {
      userId,
      sessionId,
      deviceFingerprint,
      geoLocation: context.geoLocation!,
      threatIntel,
      anomalyScore: {
        total: anomalyScore,
        deviceFingerprint: 0,
        geographicalVelocity: 0,
        threatIntel: threatIntel.threatScore,
        timeAnomalies: 0,
        browserAnomalies: 0,
      },
      riskLevel,
      requiresStepUp,
      auditTrail: [],
    };

    // Log security event
    await this.logSecurityEvent(userId, sessionId, {
      event: 'session_evaluation',
      anomalyScore,
      riskLevel,
      threatIntel,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
    });

    // Store fingerprints
    await this.storeDeviceFingerprint(userId, deviceFingerprint);
    if (geoLocation) {
      await this.storeLocation(userId, geoLocation);
    }

    // Revoke session if needed
    if (requiresStepUp) {
      await this.requestStepUpAuth(userId, sessionId);
    }

    return securityContext;
  }

  /**
   * Store device fingerprint in Redis
   */
  private async storeDeviceFingerprint(
    userId: string,
    fingerprint: DeviceFingerprint
  ): Promise<void> {
    const key = `device_fp:${userId}`;
    await redisService.set(
      key,
      JSON.stringify(fingerprint),
      DEVICE_FINGERPRINT_TTL
    );
  }

  /**
   * Get stored device fingerprint
   */
  private async getStoredDeviceFingerprint(
    userId: string
  ): Promise<DeviceFingerprint | null> {
    const key = `device_fp:${userId}`;
    const data = await redisService.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Store geolocation in Redis
   */
  private async storeLocation(
    userId: string,
    location: GeoLocation
  ): Promise<void> {
    const key = `geo_loc:${userId}`;
    await redisService.set(
      key,
      JSON.stringify(location),
      DEVICE_FINGERPRINT_TTL
    );
  }

  /**
   * Get stored geolocation
   */
  private async getStoredLocation(userId: string): Promise<GeoLocation | null> {
    const key = `geo_loc:${userId}`;
    const data = await redisService.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Log security event to audit trail
   */
  private async logSecurityEvent(
    userId: string,
    sessionId: string,
    event: Record<string, unknown>
  ): Promise<void> {
    const key = `audit:security:${userId}`;
    const entry = {
      sessionId,
      timestamp: Date.now(),
      ...event,
    };
    await redisService.lpush(key, JSON.stringify(entry));
    await redisService.expire(key, SESSION_REVOCATION_TTL);
  }

  /**
   * Request step-up authentication
   */
  private async requestStepUpAuth(
    userId: string,
    sessionId: string
  ): Promise<void> {
    const key = `step_up:${sessionId}`;
    await redisService.set(
      key,
      JSON.stringify({
        userId,
        initiated: Date.now(),
        status: 'pending',
      }),
      3600 // 1 hour TTL
    );
  }

  /**
   * Get risk level from anomaly score
   */
  private getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score < 30) return 'low';
    if (score < 60) return 'medium';
    if (score < 85) return 'high';
    return 'critical';
  }

  /**
   * Revoke session due to security incident
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const key = `revoked:${sessionId}`;
    await redisService.set(key, '1', SESSION_REVOCATION_TTL);
    await this.logSecurityEvent(userId, sessionId, {
      event: 'session_revoked',
      timestamp: Date.now(),
    });
  }

  /**
   * Check if session is revoked
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    const key = `revoked:${sessionId}`;
    return (await redisService.get(key)) !== null;
  }

  /**
   * Get audit trail for user
   */
  async getAuditTrail(
    userId: string,
    limit: number = 100
  ): Promise<AuditLogEntry[]> {
    const key = `audit:security:${userId}`;
    const entries = await redisService.lrange(key, 0, limit - 1);
    return entries.map((entry) => JSON.parse(entry));
  }
}

export const anomalyDetector = new AnomalyDetector();
export default anomalyDetector;
